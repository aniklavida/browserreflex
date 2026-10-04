import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Card } from '../src/components/Card';
import { Confidence } from '../src/components/Confidence';
import { Drawer } from '../src/components/Drawer';
import { EmptyState } from '../src/components/EmptyState';
import { MetricGrid } from '../src/components/MetricGrid';
import { PathBadge, toneForPath } from '../src/components/PathBadge';
import { ProbabilityBar } from '../src/components/ProbabilityBar';
import { SegmentedControl } from '../src/components/SegmentedControl';
import { SquareToggle } from '../src/components/SquareToggle';
import { TableRow } from '../src/components/TableRow';
import { TOAST_MS, ToastProvider, useToast } from '../src/components/Toast';
import { useCleanup } from './helpers';

useCleanup();

describe('path badge and tones', () => {
  it('uses green for memory, pattern and check, yellow for a model and red for a person', () => {
    expect(toneForPath('memory')).toBe('auto');
    expect(toneForPath('pattern')).toBe('auto');
    expect(toneForPath('check')).toBe('auto');
    expect(toneForPath('ai')).toBe('ai');
    expect(toneForPath('human')).toBe('human');
  });

  it('renders the path name with its tone', () => {
    const { container } = render(<PathBadge path="human" />);
    expect(container.querySelector('.pathbadge.tone-human')?.textContent).toBe('human');
  });

  it('shows a confidence with two decimals in the tone of its path', () => {
    const { container } = render(<Confidence value={0.9} path="ai" />);
    expect(container.textContent).toBe('0.90');
    expect(container.querySelector('.tone-ai')).not.toBeNull();
  });
});

describe('probability bar', () => {
  it('fills to the probability and clamps outside 0 to 1', () => {
    const { container, rerender } = render(<ProbabilityBar value={0.4} />);
    expect(container.querySelector<HTMLElement>('.probbar > span')?.style.width).toBe('40%');
    rerender(<ProbabilityBar value={3} suggested />);
    expect(container.querySelector<HTMLElement>('.probbar > span')?.style.width).toBe('100%');
    expect(container.querySelector('.probbar.suggested')).not.toBeNull();
    rerender(<ProbabilityBar value={-1} />);
    expect(container.querySelector<HTMLElement>('.probbar > span')?.style.width).toBe('0%');
  });
});

describe('metric grid, card and empty state', () => {
  it('renders one cell per metric', () => {
    render(
      <MetricGrid
        metrics={[
          { label: 'One', value: 1 },
          { label: 'Two', value: 2, note: 'a note' },
        ]}
      />,
    );
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText('a note')).toBeTruthy();
    expect(document.querySelectorAll('.metric-cell')).toHaveLength(2);
  });

  it('marks a safety card', () => {
    const { container } = render(<Card safety>content</Card>);
    expect(container.querySelector('.card.safety')).not.toBeNull();
  });

  it('says what will appear and offers the next step', () => {
    render(
      <EmptyState title="Nothing yet" action={<button type="button">Do this</button>}>
        Decisions appear here.
      </EmptyState>,
    );
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    expect(screen.getByText('Decisions appear here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do this' })).toBeTruthy();
  });
});

describe('segmented control and toggle', () => {
  it('marks the active option and reports a change', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Range"
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('flips on click and does nothing when disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SquareToggle checked={false} onChange={onChange} label="Gate" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Gate' }));
    expect(onChange).toHaveBeenCalledWith(true);
    onChange.mockClear();
    rerender(<SquareToggle checked onChange={onChange} label="Gate" disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'Gate' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('table row', () => {
  it('opens on click and on Enter', () => {
    const onOpen = vi.fn();
    render(
      <table>
        <tbody>
          <TableRow onOpen={onOpen}>
            <td>cell</td>
          </TableRow>
        </tbody>
      </table>,
    );
    const cell = screen.getByText('cell');
    fireEvent.click(cell);
    fireEvent.keyDown(cell.closest('tr') as HTMLElement, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe('drawer', () => {
  it('renders nothing when closed and closes on Escape and on the backdrop', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Drawer open={false} title="Detail" onClose={onClose}>
        body
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Drawer open title="Detail" onClose={onClose}>
        body
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Detail' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('toast', () => {
  function Trigger() {
    const notify = useToast();
    return (
      <button type="button" onClick={() => notify('Saved', 'human')}>
        go
      </button>
    );
  }

  it('shows a message with its tone and closes after 2.6 seconds', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    const toast = screen.getByRole('status');
    expect(toast.textContent).toBe('Saved');
    expect(toast.className).toContain('tone-human');
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(TOAST_MS).toBe(2600);
  });
});
