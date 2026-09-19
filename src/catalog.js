// Single source of truth for the interactive docs page (public/docs.html).
const { ROUTES } = require('./sports');

const dateFrom = { name: 'dateFrom', in: 'query', label: 'Start date (YYYY-MM-DD)', placeholder: '2026-08-01' };
const dateTo   = { name: 'dateTo',   in: 'query', label: 'End date (YYYY-MM-DD)',   placeholder: '2026-08-31' };
const status   = { name: 'status',   in: 'query', label: 'SCHEDULED, LIVE, FINISHED', placeholder: 'SCHEDULED' };

function sportsEndpoint(r) {
  const params = r.type === 'matches' ? [dateFrom, dateTo, status]
    : r.type === 'scorers' ? [{ name: 'limit', in: 'query', label: 'How many players (1-50)', placeholder: '10' }]
    : [];
  return { id: r.path.slice(1).replace(/\//g, '-'), title: r.title, description: r.description, variants: [{ method: 'GET', path: r.path, auth: 'none', params }] };
}

module.exports = [
  {
    category: 'AI',
    endpoints: [
      {
        id: 'ai-chat',
        title: 'AI Chat',
        description: 'Ask the assistant anything. Also answers on /ai/claude3opus and /ai/deepseekcoder for bots written for older relays. The "provider" and "model" fields always say which model actually answered.',
        variants: [
          { method: 'GET', path: '/ai/chat', auth: 'query', params: [{ name: 'prompt', in: 'query', required: true, label: 'Your question or prompt', placeholder: 'Hello' }] },
          { method: 'POST', path: '/v1/ai', auth: 'bearer', params: [
            { name: 'prompt', in: 'body', required: true, label: 'Your question or prompt', placeholder: 'Who are you?' },
            { name: 'system', in: 'body', label: 'Optional system prompt (sets the AI\'s persona)', placeholder: '' }
          ] }
        ]
      }
    ]
  },
  {
    category: 'Downloader',
    endpoints: [
      {
        id: 'download-file',
        title: 'Direct File Download',
        description: 'Fetches a file from a public HTTP/HTTPS direct link and returns a temporary download_url. Works with direct file links only (no YouTube/TikTok/Instagram pages). Private and internal addresses are blocked.',
        variants: [
          { method: 'POST', path: '/v1/download', auth: 'bearer', params: [{ name: 'url', in: 'body', required: true, label: 'Direct file URL', placeholder: 'https://example.com/file.zip' }] }
        ]
      }
    ]
  },
  {
    category: 'Music',
    endpoints: [
      {
        id: 'music-search',
        title: 'Music Search',
        description: 'Search openly-licensed music (Jamendo and Openverse). Each result has direct audio links, the licence and a ready-made attribution line. This catalog is Creative Commons and independent music, not mainstream chart songs.',
        variants: [
          { method: 'GET', path: '/music/search', auth: 'query', params: [
            { name: 'q', in: 'query', required: true, label: 'Song name or artist search query', placeholder: 'chill piano' },
            { name: 'limit', in: 'query', label: 'How many results (1-25)', placeholder: '10' },
            { name: 'commercial', in: 'query', label: 'true = only licences that allow commercial use', placeholder: 'false' }
          ] }
        ]
      }
    ]
  },
  { category: 'Sports', endpoints: ROUTES.map(sportsEndpoint) },
  {
    category: 'System',
    endpoints: [
      { id: 'health', title: 'Health', description: 'Service status, version and which AI providers are active.', variants: [{ method: 'GET', path: '/health', auth: 'none', params: [] }] },
      { id: 'stats', title: 'Stats', description: 'Request and download counters since the last restart.', variants: [{ method: 'GET', path: '/api/stats', auth: 'none', params: [] }] }
    ]
  }
];
