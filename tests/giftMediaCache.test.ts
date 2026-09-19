import test from 'node:test'
import assert from 'node:assert/strict'
import { GiftVideoMemoryCache } from '../src/main/giftMediaCache'
import { MAX_GIFT_VIDEO_BYTES, readGiftVideoBytes } from '../src/shared/vap'

const signal = (): AbortSignal => new AbortController().signal

test('视频内存缓存按最近使用淘汰，超预算单项不保留', async () => {
  const requests: string[] = []
  const cache = new GiftVideoMemoryCache(async url => {
    requests.push(url)
    return new ArrayBuffer(url === 'large' ? 8 : 3)
  }, 6)
  const a = await cache.get('a', signal())
  await cache.get('b', signal())
  assert.equal(cache.bytes, 6)
  assert.equal(await cache.get('a', signal()), a)
  await cache.get('c', signal())
  assert.equal(await cache.get('a', signal()), a)
  await cache.get('b', signal())
  assert.deepEqual(requests, ['a', 'b', 'c', 'b'])
  await cache.get('large', signal())
  await cache.get('large', signal())
  assert.equal(cache.bytes, 6)
  assert.equal(requests.filter(url => url === 'large').length, 2)
  cache.clear()
  assert.equal(cache.bytes, 0)
})

test('视频清理中止下载，迟到响应不能回填缓存，也不阻塞下一次播放', async () => {
  const pending: { signal: AbortSignal; finish: (data: ArrayBuffer) => void }[] = []
  const cache = new GiftVideoMemoryCache(async (url, requestSignal) => {
    if (url === 'new') return new ArrayBuffer(4)
    return new Promise<ArrayBuffer>(resolve => pending.push({ signal: requestSignal, finish: resolve }))
  }, 8)
  const first = cache.get('old-a', signal()), second = cache.get('old-b', signal())
  const firstCanceled = assert.rejects(first, { name: 'AbortError' })
  const secondCanceled = assert.rejects(second, { name: 'AbortError' })
  await assert.rejects(cache.get('third', signal()), /正在加载/)
  cache.clear()
  assert.ok(pending.every(item => item.signal.aborted))
  await cache.get('new', signal())
  for (const item of pending) item.finish(new ArrayBuffer(8))
  await Promise.all([firstCanceled, secondCanceled])
  assert.equal(cache.bytes, 4)
  assert.equal((await cache.get('new', signal())).byteLength, 4)
})

test('取消播放和下载失败均释放名额，失败结果不作为缓存命中', async () => {
  let requests = 0
  const cache = new GiftVideoMemoryCache(async (_url, requestSignal) => {
    requests++
    if (requests === 1) return new Promise<ArrayBuffer>((_resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
    })
    if (requests === 2) throw new Error('offline')
    return new ArrayBuffer(2)
  })
  const alreadyCanceled = new AbortController()
  alreadyCanceled.abort()
  await assert.rejects(cache.get('a', alreadyCanceled.signal), { name: 'AbortError' })
  assert.equal(requests, 0)
  const controller = new AbortController(), request = cache.get('a', controller.signal)
  const canceled = assert.rejects(request, { name: 'AbortError' })
  controller.abort()
  await canceled
  await assert.rejects(cache.get('a', signal()), /offline/)
  assert.equal(cache.bytes, 0)
  assert.equal((await cache.get('a', signal())).byteLength, 2)
  assert.equal(requests, 3)
})

test('声明超限或 HTTP 失败的视频立即取消响应，不读取正文', async () => {
  for (const options of [
    { status: 200, headers: { 'Content-Length': String(MAX_GIFT_VIDEO_BYTES + 1) } },
    { status: 502 }
  ]) {
    let canceled = false, reads = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array([1])) },
      cancel() { canceled = true }
    }, { highWaterMark: 0 })
    await assert.rejects(readGiftVideoBytes(new Response(stream, options)), /限制/)
    assert.equal(canceled, true)
    assert.equal(reads, 0)
  }
})

test('缺失或虚报 Content-Length 时仍按实际字节限流并中止上游', async () => {
  for (const declared of [undefined, '1']) {
    let canceled = false, reads = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(++reads === 1 ? MAX_GIFT_VIDEO_BYTES : 1)) },
      cancel() { canceled = true }
    }, { highWaterMark: 0 })
    const response = new Response(stream, { headers: declared ? { 'Content-Length': declared } : {} })
    await assert.rejects(readGiftVideoBytes(response), /限制/)
    assert.equal(canceled, true)
    assert.equal(reads, 2)
  }
})

test('分块视频完整读取后释放 reader，传输中断不返回部分视频', async () => {
  let reads = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]))
      else if (reads === 2) controller.enqueue(new Uint8Array([3, 4, 5]))
      else controller.close()
    }
  }, { highWaterMark: 0 })
  const data = await readGiftVideoBytes(new Response(stream))
  assert.deepEqual([...new Uint8Array(data)], [1, 2, 3, 4, 5])
  assert.equal(stream.locked, false)
  const failed = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('interrupted')) }
  })
  await assert.rejects(readGiftVideoBytes(new Response(failed)), /interrupted/)
  assert.equal(failed.locked, false)
})
