const http = require('http');

const PORT = process.argv[2] || process.env.PORT || 9999;

const server = http.createServer((req, res) => {
  const timestamp = new Date().toISOString();
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    console.log('\n' + '='.repeat(60));
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log('-'.repeat(60));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    if (body) {
      console.log('-'.repeat(60));
      try {
        console.log('Body:', JSON.stringify(JSON.parse(body), null, 2));
      } catch {
        console.log('Body (raw):', body);
      }
    }
    console.log('='.repeat(60) + '\n');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, timestamp }));
  });
});

server.listen(PORT, () => {
  console.log(`Webhook test server listening on http://localhost:${PORT}`);
  console.log('Waiting for requests...\n');
});
