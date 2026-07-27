globalThis.fetch = async () => new Response(
  process.env.MOCK_FETCH_BODY || '',
  {
    status: Number(process.env.MOCK_FETCH_STATUS || 200),
    headers: { 'content-type': 'application/json' },
  },
);
