export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=43200');

  try {
    const today  = new Date();
    const future = new Date(Date.now() + 42 * 86400000);
    const fmt    = d => d.toISOString().slice(0, 10);

    const url = `https://financialmodelingprep.com/api/v3/economic_calendar`
      + `?from=${fmt(today)}&to=${fmt(future)}&apikey=${process.env.FMP_KEY}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();

    if (!r.ok) throw new Error(`FMP ${r.status}: ${text.slice(0, 300)}`);

    let d;
    try { d = JSON.parse(text); }
    catch { throw new Error(`Geen geldige JSON: ${text.slice(0, 300)}`); }

    if (!Array.isArray(d)) {
      throw new Error(d?.['Error Message'] || d?.message || `Geen array: ${text.slice(0, 300)}`);
    }

    res.status(200).json(d);
  } catch (e) {
    console.error('Kalender fout:', e.message);
    res.status(500).json({ error: e.message });
  }
}
