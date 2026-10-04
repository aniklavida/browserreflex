import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import { Analytics } from './pages/Analytics';
import { Dashboard } from './pages/Dashboard';
import { Engines } from './pages/Engines';
import { Learned } from './pages/Learned';
import { Integrations } from './pages/Integrations';
import { Live } from './pages/Live';
import { Logs } from './pages/Logs';
import { Packs } from './pages/Packs';
import { Patterns } from './pages/Patterns';
import { Replay } from './pages/Replay';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Review } from './pages/Review';
import { Setup } from './pages/Setup';
import { Thresholds } from './pages/Thresholds';

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route
          path="*"
          element={
            <Shell>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/live" element={<Live />} />
                <Route path="/review" element={<Review />} />
                <Route path="/patterns" element={<Patterns />} />
                <Route path="/packs" element={<Packs />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/replay" element={<Replay />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/learned" element={<Learned />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/thresholds" element={<Thresholds />} />
                <Route path="/engines" element={<Engines />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Shell>
          }
        />
      </Routes>
    </ToastProvider>
  );
}

function NotFound() {
  return (
    <div className="page">
      <div className="empty">
        <strong>Nothing here</strong>
        <span>There is no page at this address. Use the sidebar.</span>
      </div>
    </div>
  );
}
