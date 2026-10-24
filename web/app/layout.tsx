import 'leaflet/dist/leaflet.css';
import type { Metadata, Viewport } from 'next';
import '../src/styles.css';
import { ServiceWorker } from '../src/shell/ServiceWorker';

export const metadata: Metadata = {
  title: 'Medone – Cấp cứu ngoại viện',
  description: 'Phần mềm điều phối Dịch vụ Chuyển viện - Cấp cứu ngoại viện Medone',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/logo.svg' },
};

export const viewport: Viewport = { themeColor: '#0b4ea2', width: 'device-width', initialScale: 1 };

// Đặt nền sáng/tối trước khi vẽ trang để không bị nháy màu
const themeScript = `try{document.documentElement.dataset.theme=localStorage.getItem('medone.theme')||'dark'}catch(e){document.documentElement.dataset.theme='dark'}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
