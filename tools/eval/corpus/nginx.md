# nginx reference

Config snippets for serving sites and proxying apps with nginx.

## Reverse proxy

Inside a server block, location / { proxy_pass http://127.0.0.1:3000; } forwards requests to a local app.
Add proxy_set_header Host $host and proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for so the app sees the real client.

## Test and reload

nginx -t checks the configuration for syntax errors before anything changes.
nginx -s reload applies a new configuration without dropping open connections.

## HTTPS

listen 443 ssl together with ssl_certificate and ssl_certificate_key turns on TLS for a server block.
A second server block on port 80 with return 301 https://$host$request_uri sends plain HTTP visitors to HTTPS.

## Static files

root /var/www/site serves files from a folder, and try_files $uri $uri/ /index.html sends unknown paths
to a single page app. Set expires 30d on asset locations so browsers cache them.
