export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=43200'); // Vercel cache: 12 uur

  try {
    const today  = new Date();
    const future = new Date(Date.now() + 42 * 86400000);
    const fmt    = d => d.toISOString().slice(0, 10);

    const url = `https://financialmodelingprep.com/api/v3/economic_calendar`
      + `?from=${fmt(today)}&to=${fmt(future)}&apikey=${process.env.FMP_KEY}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`FMP ${r.status}`);

    const d = await r.json();

    // FMP geeft altijd een array; geef foutmelding als dat niet zo is
    if (!Array.isArray(d)) {
      throw new Error(d?.['Error Message'] || d?.message || 'Onverwacht antwoord van FMP');
    }

    res.status(200).json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
