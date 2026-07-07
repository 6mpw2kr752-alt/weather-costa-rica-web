export default function Home() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
        color: '#1a1a1a',
        background: '#f6f6f4',
      }}
    >
      <h1 style={{ fontSize: '1.6rem', fontWeight: 500 }}>
        Station Meteo Costa Rica
      </h1>
      <p style={{ color: '#555', maxWidth: 420, lineHeight: 1.6 }}>
        Le service est en ligne. Les donnees envoyees par TTN sont recues sur{' '}
        <code style={{ background: '#e9e9e6', padding: '2px 6px', borderRadius: 4 }}>
          /api/ttn
        </code>{' '}
        et enregistrees dans Supabase.
      </p>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        Le tableau de bord viendra ici a la prochaine etape.
      </p>
    </main>
  );
}
