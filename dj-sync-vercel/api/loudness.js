// Função da Vercel: devolve a loudness (LUFS) de um vídeo do YouTube.
// O backend no Render usa isso quando o IP dele é bloqueado pelo YouTube.
// Não precisa de dependências externas.
//
// O cliente WEB da API do YouTube costuma devolver LOGIN_REQUIRED em IPs de
// datacenter (Render/Vercel). Os clientes ANDROID e iOS abaixo respondem sem
// exigir login e também expõem playerConfig.audioConfig.trackAbsoluteLoudnessLkfs.

const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CLIENTS = [
  {
    name: 'ANDROID',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    headerName: '3',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'pt', gl: 'BR' },
  },
  {
    name: 'IOS',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
    headerName: '5',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'pt', gl: 'BR' },
  },
  {
    name: 'IOS-20.49.6',
    ua: 'com.google.ios.youtube/20.49.6 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
    headerName: '5',
    client: { clientName: 'IOS', clientVersion: '20.49.6', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'pt', gl: 'BR' },
  },
];

let config = { key: null, sts: 0, fetchedAt: 0 };

async function getConfig() {
  if (config.key && Date.now() - config.fetchedAt < 30 * 60 * 1000) return config;

  const response = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': UA_WEB, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`homepage respondeu ${response.status}`);

  const html = await response.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const sts = Number(html.match(/"STS":(\d+)/)?.[1] || 0);
  if (!key) throw new Error('chave do player não encontrada');

  config = { key, sts, fetchedAt: Date.now() };
  return config;
}

function loudnessOf(data) {
  const audio = data?.playerConfig?.audioConfig || {};
  const lufs = Number(audio.trackAbsoluteLoudnessLkfs ?? audio.perceptualLoudnessDb);
  if (!Number.isFinite(lufs)) {
    const status = data?.playabilityStatus?.status || 'sem status';
    const reason = String(data?.playabilityStatus?.reason || '').slice(0, 80);
    throw new Error(`loudness não encontrada (${status}${reason ? ' — ' + reason : ''})`);
  }
  return lufs;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Só respostas com loudness devem ser cacheadas; erros 422/502 podem mudar.

  const id = String(req.query?.id || '').trim();
  const debug = String(req.query?.debug || '') === '1';
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    res.status(400).json({ error: 'id de vídeo inválido' });
    return;
  }

  const attempts = [];
  try {
    const { key, sts } = await getConfig();

    for (const spec of CLIENTS) {
      try {
        const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': spec.ua,
            'X-Youtube-Client-Name': spec.headerName,
            'X-Youtube-Client-Version': spec.client.clientVersion,
            Origin: 'https://www.youtube.com',
          },
          body: JSON.stringify({
            context: { client: spec.client },
            videoId: id,
            contentCheckOk: true,
            racyCheckOk: true,
            ...(sts ? { playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } } } : {}),
          }),
          signal: AbortSignal.timeout(2000),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`player respondeu ${response.status}`);
        const lufs = loudnessOf(data);
        attempts.push({ client: spec.name, status: response.status, playability: data.playabilityStatus?.status, lufs });
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        res.status(200).json(debug ? { lufs, attempts } : { lufs });
        return;
      } catch (error) {
        attempts.push({ client: spec.name, error: String(error.message || error).slice(0, 120) });
      }
    }

    res.status(422).json(debug ? { error: 'loudness não encontrada', attempts } : { error: 'loudness não encontrada' });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 160), ...(debug ? { attempts } : {}) });
  }
};
