const prexit = require('prexit')
prexit.signals.push('unhandledRejection')
prexit.logExceptions = false

module.exports = function (opts) {
  prexit(async (signal, error) => {
    if ([0, 'SIGTERM', 'SIGINT'].includes(signal)) {
      opts.logger.warn(`Signal ${signal} received. Shutting down after running for ${process.uptime()}s`)
    } else {
      const err = signal instanceof Error ? signal : error
      opts.logger.fatal({err}, `Processing error. Shutting down after running for ${process.uptime()}s`)
    }

    if (opts.onStop) await opts.onStop()
  })
}
