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

      do {
        try {
          const addresses = await dns.lookup(parsed.hostname, {
            family: 4,
            all: true,
            verbatim: true
          })

          if (!addresses.length) {
            throw new Error(`Requested dns record doesn't respond with any A records.`)
          }
          instances = addresses.map((host) => {
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
      setTimeout(() => { needsUpdate = true }, 5000).unref()
    }

    return async function request (opts) {
      if (needsUpdate) refreshAdresses()
      if (!instances) await instancesPromise
      if (opts.onlyOne) return axios({...opts, baseURL: instances[0], onlyOne: undefined})

      return Promise.all(instances.map((baseURL) => axios({...opts, baseURL: baseURL})))
    }
  }
}
