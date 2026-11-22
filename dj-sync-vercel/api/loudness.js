// Função da Vercel: devolve a loudness (LUFS) de um vídeo do YouTube.
// O backend no Render usa isso quando o IP dele é bloqueado pelo YouTube.
// Não precisa de dependências externas.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let config = { key: null, version: null, sts: 0, visitor: null, cookie: null, fetchedAt: 0 };

async function getConfig() {
  if (config.key && Date.now() - config.fetchedAt < 30 * 60 * 1000) return config;

  const response = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`homepage respondeu ${response.status}`);

  const html = await response.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const sts = Number(html.match(/"STS":(\d+)/)?.[1] || 0);
  const visitor = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || undefined;
  if (!key || !version || !sts) throw new Error('configuração do player não encontrada');

  config = {
    key,
    version,
    sts,
    visitor,
    cookie: response.headers.get('set-cookie') || undefined,
    fetchedAt: Date.now(),
  };
  return config;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');

  const id = String(req.query?.id || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    res.status(400).json({ error: 'id de vídeo inválido' });
    return;
  }

  try {
    const { key, version, sts, visitor, cookie } = await getConfig();
    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': version,
        ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: version,
            hl: 'pt',
            gl: 'BR',
            ...(visitor ? { visitorData: visitor } : {}),
          },
        },
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      res.status(502).json({ error: `player respondeu ${response.status}` });
      return;
    }

    const data = await response.json();
    const audio = data?.playerConfig?.audioConfig || {};
    const lufs = Number(audio.trackAbsoluteLoudnessLkfs ?? audio.perceptualLoudnessDb);
    if (!Number.isFinite(lufs)) {
      res.status(422).json({
        error: 'loudness não encontrada',
        playability: data?.playabilityStatus?.status || null,
        reason: String(data?.playabilityStatus?.reason || '').slice(0, 120),
      });
      return;
    }

    res.status(200).json({ lufs });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 160) });
  }
};
