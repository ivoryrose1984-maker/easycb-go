import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Arb Dashboard',
  description: 'Live MEV arbitrage tracking dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className="min-h-screen font-mono antialiased"
        style={{ backgroundColor: '#0a0a0a', color: '#e4e4e7' }}
      >
        {children}
      </body>
    </html>
  );
}
