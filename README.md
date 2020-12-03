# varnish-purge

Polls document publication events from livingdocs and triggers a ban or x-cache-tags purge based on the event type.
It also requests the new document right after invalidating the cache, so pages get prerendered.

There are two operation modes.
- We can use one central instance, which operates against multiple varnish instances.
  To enable that, please use the `VARNISH_MULTIPURGE=true` environment variable.

- Then in the regular operation mode, it only operates against one varnish instance,
  so the service can be installed as sidecar to varnish.


To start fetching the publication events and actively ban pages based on updates, just start the process:
```
process.env.TOKEN = 'eyJhb...'
process.env.API_URL = 'http://livingdocs-server:9090'
process.env.VARNISH_URL = 'http://frontend:80/'
process.env.FRONTEND_URL = 'https://livingdocs.io/'
process.env.VARNISH_MULTIPURGE = 'true'

node index.js
```

To precache existing pages, you can run the same process using a `--precache` argument.
E.g. to precache all the pages published or updated within the last 2 weeks, execute that command:
```
node index.js --precache --duration=2w --documentType=page
```
