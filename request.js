const { logExceptions } = require('prexit')

module.exports = {
  create (opts) {
    const log = opts.logger
    const dns = require('dns').promises
    const axios = require('axios').create({...opts, baseURL: undefined, logger: undefined})

    const parsed = new URL(opts.baseURL)
    let needsUpdate = true
    let instances

    async function refreshAdresses () {
      needsUpdate = false

      let ttl
      do {
        try {
          const addresses = await dns.resolve4(parsed.host, {ttl: true})
          instances = addresses.map((host) => {
            ttl = host.ttl
            return `${parsed.protocol}//${host.address}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}` // eslint-disable-line max-len
          })
        } catch (err) {
          log.error({err}, 'DNS Resolution Error')
        }
      } while (!instances)

      setTimeout(() => { needsUpdate = true }, Math.max(ttl, 10) * 1000).unref()
    }

    return async function request (opts) {
      if (needsUpdate) instances ? refreshAdresses() : await refreshAdresses()
      if (opts.onlyOne) return axios({...opts, baseURL: instances[0], onlyOne: undefined})

      return Promise.all(instances.map((baseURL) => axios({...opts, baseURL: baseURL})))
    }
  }
}
