<h1 align="center">
  <img alt="SemBeacon" src="https://sembeacon.org/images/logo.svg" width="50%" /><br />
  @sembeacon/proxy
</h1>

<br />

This repository contains a server for proxying linked data requests.

## Usage

### Installation
```text
yarn install
```

### Proxy requests
`curl --header "Accept: text/turtle" "http://localhost:4899/?uri=https://sembeacon.org/examples/openhps2021/beacons_v2.ttl&api=test123"`

### Configuration
```json
{
    "applications": [
        {
            "id": "example",
            "name": "Example Application",
            "key": "test123",
            "limit": "1MB",
            "accept": ["application/rdf+xml", "application/ld+json", "text/turtle"],
            "cacheTimeout": 60,
            "rateLimit": {
                "windowSeconds": 60,
                "max": 300
            }
        }
    ],
    "port": "4899",
    "log": {
        "level": "debug"
    }
}
```


#### `id`
A unique identifier for the application.

#### `name`
The name of the application for logging purposes.

#### `key`
The key to use for the application. This key is required to shorten URLs. If possible, try to keep this key secret.

### `limit`
The maximum upstream response size. Accepts `B`, `KB`, `MB` or `GB` (for example `1MB`).
Default: `1MB`.

### `timeout`
Upstream request timeout in milliseconds. Default: `5000`.

### `accept`
Accepted request and response media types to proxy. Responses with another
`Content-Type` are rejected.

### `cacheTimeout`
Cache timeout using Redis. The cache is keyed by the target URI **and** the
`Accept` header, so different representations are never mixed.

### `rateLimit`
Per-application rate limit, applied per client IP and shared through Redis:

```json
"rateLimit": {
    "windowSeconds": 60,
    "max": 300
}
```

Default: 300 requests per 60 seconds.

## Security

The proxy only forwards `GET` and `HEAD` requests to public `http`/`https` URIs:

- Loopback, private, link-local, CGNAT, multicast, reserved and cloud-metadata
  addresses are rejected (IPv4 and IPv6, including IPv4-mapped addresses).
- Hostnames are resolved before the request and again at connection time, so a
  second DNS answer cannot rebind the connection to a private address.
- Redirects are validated and limited to three hops.
- `limit` caps the response size; `timeout` caps the request time.
- Cookies, hop-by-hop headers and re-encoded bodies are never forwarded.
- Logs contain the path only, never the query string (which holds the API key
  and the target URI).

API keys are public client identifiers, not secrets. Keep the per-application
rate limit enabled and rotate a key if it is abused.

### Docker
A docker file is available on [Docker Hub](https://hub.docker.com/r/sembeacon/proxy/tags). You can run the following command to start the server:
```bash
docker run -d -p 4899:4899 -e REDIS_USER=redis -e REDIS_PASSWORD=redis -e REDIS_HOST=redis -e REDIS_PORT=6379 sembeacon/proxy
```
Override the `config.json` file located in `/opt/proxy/config.json` with your own configuration.

## Contributors
The framework is open source and is mainly developed by Dr. Maxim Van de Wynckel as part of his PhD research towards *Interoperable and Discoverable Indoor Positioning Systems* under the supervision of Prof. Dr. Beat Signer.

## Contributing
Use of OpenHPS, SemBeacon, contributions and feedback is highly appreciated. Please read our [contributing guidelines](CONTRIBUTING.md) for more information.

## License
Copyright (C) 2019-2025 Maxim Van de Wynckel & Vrije Universiteit Brussel

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.