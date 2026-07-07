export const metadata = {
  title: 'Station Meteo Costa Rica',
  description: 'Reception des donnees TTN',
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
