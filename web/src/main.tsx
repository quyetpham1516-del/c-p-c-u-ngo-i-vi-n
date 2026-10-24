import 'leaflet/dist/leaflet.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { homeFor, session } from './api';
import { Layout } from './components/Layout';
import { Board } from './pages/Board';
import { Crew } from './pages/Crew';
import { Eoc } from './pages/Eoc';
import { Login } from './pages/Login';
import { PatientDetail, Patients } from './pages/Patients';
import { Trace } from './pages/Trace';
import { TransferPrint } from './pages/TransferPrint';
import './styles.css';

function Protected({ children }: { children: React.ReactNode }) {
  if (!session.token) return <Navigate to="/dang-nhap" replace />;
  return <Layout>{children}</Layout>;
}

try {
  const t = localStorage.getItem('medone.theme');
  document.documentElement.dataset.theme = t ?? 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/dang-nhap" element={<Login />} />
        <Route path="/eoc" element={<Protected><Eoc /></Protected>} />
        <Route path="/bang-xe" element={<Protected><Board /></Protected>} />
        <Route path="/kip" element={<Protected><Crew /></Protected>} />
        <Route path="/benh-an" element={<Protected><Patients /></Protected>} />
        <Route path="/benh-an/:id" element={<Protected><PatientDetail /></Protected>} />
        <Route path="/ca/:id/truy-xuat" element={<Protected><Trace /></Protected>} />
        <Route path="/phieu/:id" element={<Protected><TransferPrint /></Protected>} />
        <Route path="*" element={<Navigate to={session.token ? homeFor(session.user?.role) : '/dang-nhap'} replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
