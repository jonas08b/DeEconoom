export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400'); // Vercel cache: 1 dag

  try {
    const url = `https://www.alphavantage.co/query?function=ECONOMIC_CALENDAR&horizon=3month&apikey=${process.env.AV_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    res.status(200).json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
