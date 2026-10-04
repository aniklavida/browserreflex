import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import { Analytics } from './pages/Analytics';
import { Dashboard } from './pages/Dashboard';
import { Engines } from './pages/Engines';
import { Learned } from './pages/Learned';
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
                <Route path="/review" element={<Review />} />
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
        <span>This page is not built yet. Use the sidebar to go to a page that is.</span>
      </div>
    </div>
  );
}
