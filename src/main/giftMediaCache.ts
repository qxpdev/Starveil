/** 视频只在内存保留，避免首次播放依赖慢速 Chromium 视频下载或另建磁盘目录。 */
export class GiftVideoMemoryCache {
  private entries = new Map<string, ArrayBuffer>()
  private loading = new Set<AbortController>()
  private generation = 0
  private size = 0

  constructor(private readonly download: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>,
    private readonly budget = 32 * 1024 * 1024) {}

  get bytes(): number { return this.size }

  async get(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted()
    const cached = this.entries.get(url)
    if (cached) { this.entries.delete(url); this.entries.set(url, cached); return cached }
    if (this.loading.size >= 2) throw new Error('礼物动画正在加载')
    const controller = new AbortController(), generation = this.generation
    const requestSignal = AbortSignal.any([signal, controller.signal])
    this.loading.add(controller)
    try {
      const bytes = await this.download(url, requestSignal)
      requestSignal.throwIfAborted()
      if (generation === this.generation && bytes.byteLength <= this.budget) {
        if (this.entries.has(url)) { this.size -= this.entries.get(url)!.byteLength; this.entries.delete(url) }
        while (this.entries.size && this.size + bytes.byteLength > this.budget) {
          const oldest = this.entries.keys().next().value!
          this.size -= this.entries.get(oldest)!.byteLength; this.entries.delete(oldest)
        }
        this.entries.set(url, bytes); this.size += bytes.byteLength
      }
      return bytes
    } finally { this.loading.delete(controller) }
  }

  clear(): void {
    this.generation++
    this.entries.clear(); this.size = 0
    for (const controller of this.loading) controller.abort()
    this.loading.clear()
  }
}
