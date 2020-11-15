const Denque = require('denque')

// Queue that doesn't have the buggy drain behavior of async/queue
// And it doesn't support promises on `.push()`
module.exports = function fastAsyncQueue (opts) {
  const queue = new Denque()
  const unusedWorkers = new Denque()

  const processFn = opts.process
  const catchFn = opts.catch
  const context = opts.context
  const concurrency = opts.concurrency || 10
  if (typeof concurrency !== 'number') {
    throw new Error('fastAsyncQueue: opts.concurrency must be a number')
  }

  if (typeof processFn !== 'function') {
    throw new Error('fastAsyncQueue: opts.process must be a function')
  }

  if (catchFn && typeof catchFn !== 'function') {
    throw new Error('fastAsyncQueue: opts.catch must be a function')
  }

  let stopped
  let drainResolve
  let drainLowWaterMark
  let pausePromise
  async function createWorker () {
    // eslint-disable-next-line no-unmodified-loop-condition
    while (!stopped) {
      await new Promise((launchWorker) => unusedWorkers.push(launchWorker))

      let job
      while ((job = queue.shift())) {
        if (pausePromise) await pausePromise
        if (stopped) return

        try {
          const res = processFn.call(context, job)
          if (res && res.then) await res
        } catch (err) {
          if (catchFn) await catchFn.call(context, err, job)
          else throw err
        }

        if (drainLowWaterMark !== undefined && queue.length <= drainLowWaterMark) {
          drainResolve()
          drainResolve = undefined
          drainLowWaterMark = undefined
        }
      }
    }
  }

  for (let i = 0; i < concurrency; i++) createWorker()

  return {
    get length () {
      return queue.length
    },
    pause () {
      let resolve
      const promise = new Promise((_resolve) => {
        resolve = _resolve
      })
      promise.resolve = resolve
      pausePromise = promise
    },
    resume () {
      if (!pausePromise) return
      pausePromise.resolve()
      pausePromise = undefined
    },
    stop () {
      stopped = true
      if (pausePromise) pausePromise.resolve()
    },
    push (data) {
      queue.push(data)
      if (unusedWorkers.length) unusedWorkers.shift()()
    },
    unshift (data) {
      queue.unshift(data)
      if (unusedWorkers.length) unusedWorkers.shift()()
    },
    clear () {
      queue.clear()
      return this
    },
    drain (lowWaterMark = 0) {
      if (queue.length <= lowWaterMark) return
      return new Promise((resolve) => {
        drainResolve = resolve
        drainLowWaterMark = lowWaterMark
      })
    }
  }
}
