module.exports = function createWorker (opts) {
  const queue = require('./fast-async-queue')({
    concurrency: opts.concurrency,
    async process (job) {
      job._tries = job._tries + 1

      const {documentId, _project: project} = job
      project.log.info({documentId}, `Document ${job.event} start`)


      if (job.event === 'unpublish') {
        await project.varnishRequest({
          validateStatus (status) { return status < 500 },
          method: 'BAN',
          url: `/ban`,
          headers: {
            Host: opts.frontendHostHeader,
            'X-Cache-Tags': `document=${documentId}`
          }
        })
        project.log.info({documentId}, `Document ${job.event} end`)
        return
      }

      // We should get a 301 or 302 here
      const pathRes = await project.varnishRequest({
        onlyOne: true,
        validateStatus: null,
        method: 'HEAD',
        maxRedirects: 0,
        url: `${project.pathPrefix}purge-${documentId}.html`,
        headers: {
          Host: opts.frontendHostHeader,
          Accept: 'text/html'
        }
      })

      // trigger a softpurge
      await project.varnishRequest({
        validateStatus: null,
        method: 'PURGE',
        url: `/softpurge`,
        headers: {
          Host: opts.frontendHostHeader,
          'X-Cache-Tags': `document=${documentId}`
        }
      })

      if (pathRes.status !== 301 && pathRes.status !== 302) {
        return project.log.info(
          {documentId, status: pathRes.status},
          `Document ${job.event}. ` +
          `But couldn't trigger a refresh because the url lookup failed.`
        )
      }

      const url = new URL(pathRes.headers.location, 'https://fake.com').pathname

      await Promise.all([
        // Precache the regular page
        project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url: url,
          headers: {
            Host: opts.frontendHostHeader,
            Accept: 'text/html'
          }
        }),
        // Precache the amp website
        job.documentType === 'article' && project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url: url.replace(/.html$/, '.amp.html'),
          headers: {
            Host: opts.frontendHostHeader,
            Accept: 'text/html'
          }
        }),
        // Precache the bluewin app content
        project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url,
          headers: {
            Host: opts.frontendHostHeader,
            Accept: 'application/json',
            'User-Agent': 'bluewin-app'
          }
        })
      ])

      project.log.info({documentId, url}, `Document ${job.event} end`)
    },
    catch (err, job) {
      if (job) {
        // try again right after the first failure
        if (job._tries === 1) setTimeout(() => queue.unshift(job), 3000)

        // try again, but after the queue is empty and after 5 seconds
        else if (job._tries === 2) setTimeout(() => queue.unshift(job), 10000)

        const ctx = {
          job: {...job, _project: undefined},
          err: {
            message: err.message,
            stack: err.stack,
            status: err.response && err.response.status,
            data: err.response && err.response.data
          }
        }

        if (job._tries < 3) {
          job._project.log.info(ctx, `Job failed ${job._tries} times. Retrying.`)
        } else {
          job._project.log.info(ctx, `Job failed after ${job._tries} retries. Cancelling.`)
        }
        return
      } else {
        opts.log.error({err}, 'Job Queue Error')
      }
    }
  })

  return queue
}
