module.exports = {
  create (opts) {
    const log = opts.logger
    const dns = require('dns').promises
    const axios = require('axios').create({...opts, baseURL: undefined, logger: undefined})

    const parsed = new URL(opts.baseURL)
    let needsUpdate = true
    let instances
    let instancesPromiseResolve
    const instancesPromise = new Promise((resolve) => { instancesPromiseResolve = resolve })

    async function refreshAdresses () {
      needsUpdate = false

      let ttl
      do {
        try {
          const addresses = await dns.resolve4(parsed.host, {ttl: true})
          if (!addresses.length) {
            throw new Error(`Requested dns record doesn't respond with any A records.`)
          }
          instances = addresses.map((host) => {
            ttl = host.ttl
            return `${parsed.protocol}//${host.address}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}` // eslint-disable-line max-len
          })
        } catch (err) {
          log.error({err}, 'DNS Resolution Error')
        }
      } while (!instances)
      if (instancesPromiseResolve) {
        instancesPromiseResolve()
        instancesPromiseResolve = undefined
      }
      setTimeout(() => { needsUpdate = true }, Math.max(ttl, 10) * 1000).unref()
    }

    return async function request (opts) {
      if (needsUpdate) refreshAdresses()
      if (!instances) await instancesPromise
      if (opts.onlyOne) return axios({...opts, baseURL: instances[0], onlyOne: undefined})

      return Promise.all(instances.map((baseURL) => axios({...opts, baseURL: baseURL})))
    }
  }
}
