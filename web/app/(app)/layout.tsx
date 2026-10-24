import { Protected } from '../../src/shell/Protected';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Protected>{children}</Protected>;
}
