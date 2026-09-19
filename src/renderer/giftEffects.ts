import type { DanmakuPayload } from '../shared/types'
import { officialGiftUrl } from '../shared/giftMedia'
import { MAX_GIFT_VIDEO_SECONDS, parseVapInfo, readGiftVideoBytes, type VapInfo } from '../shared/vap'

async function loadVideo(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`xingmu-gift://media/?url=${encodeURIComponent(url)}`, { signal, credentials: 'omit' })
  return readGiftVideoBytes(response)
}

function createRenderer(canvas: HTMLCanvasElement, info: VapInfo): { draw: (video: HTMLVideoElement) => void; dispose: () => void } {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('透明动画渲染不可用')
  const vertex = gl.createShader(gl.VERTEX_SHADER)!, fragment = gl.createShader(gl.FRAGMENT_SHADER)!
  const program = gl.createProgram()!, buffer = gl.createBuffer()!, texture = gl.createTexture()!
  const dispose = (): void => {
    gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program)
    gl.deleteShader(vertex); gl.deleteShader(fragment)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try {
    gl.shaderSource(vertex, 'attribute vec2 position; varying vec2 uv; void main(){ gl_Position=vec4(position,0.,1.); uv=vec2((position.x+1.)*.5,(1.-position.y)*.5); }')
    gl.shaderSource(fragment, `precision mediump float;
      uniform sampler2D video; uniform vec2 size; uniform vec4 rgb; uniform vec4 alpha; varying vec2 uv;
      void main(){
        vec3 color=texture2D(video,(rgb.xy+uv*rgb.zw)/size).rgb;
        float a=texture2D(video,(alpha.xy+uv*alpha.zw)/size).r;
        gl_FragColor=vec4(color*a,a);
      }`)
    for (const shader of [vertex, fragment]) {
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('透明动画着色器不可用')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('透明动画程序不可用')
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(program, 'video'), 0)
    gl.uniform2f(gl.getUniformLocation(program, 'size'), info.videoWidth, info.videoHeight)
    gl.uniform4fv(gl.getUniformLocation(program, 'rgb'), info.rgb)
    gl.uniform4fv(gl.getUniformLocation(program, 'alpha'), info.alpha)
    gl.viewport(0, 0, canvas.width, canvas.height)
    return {
      draw(video): void {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }, dispose
    }
  } catch (error) { dispose(); throw error }
}

/** 仅在内存解码与缓存，结束后释放当前播放器的视频、Blob 与 GPU。 */
async function playVap(host: HTMLElement, url: string, signal: AbortSignal): Promise<void> {
  const bytes = await loadVideo(url, signal)
  signal.throwIfAborted()
  const info = parseVapInfo(bytes)
  if (!info) throw new Error('此礼物动画暂不支持透明播放')
  const video = document.createElement('video')
  video.muted = true; video.playsInline = true; video.preload = 'auto'
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
  const canvas = document.createElement('canvas')
  canvas.className = 'gift-effect-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const scale = Math.min(1, Math.max(96, host.clientWidth * devicePixelRatio) / info.width, 384 / info.height)
  canvas.width = Math.max(1, Math.round(info.width * scale))
  canvas.height = Math.max(1, Math.round(info.height * scale))
  let renderer: ReturnType<typeof createRenderer> | undefined
  let frame = 0
  let frameIsVideo = false
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      video.onloadeddata = () => { signal.removeEventListener('abort', abort); resolve() }
      video.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('礼物视频加载失败')) }
      video.src = blobUrl
    })
    signal.throwIfAborted()
    if (video.videoWidth !== info.videoWidth || video.videoHeight !== info.videoHeight ||
        !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > MAX_GIFT_VIDEO_SECONDS) throw new Error('礼物视频与透明信息不匹配')
    renderer = createRenderer(canvas, info)
    host.appendChild(canvas)
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
      signal.addEventListener('abort', abort, { once: true })
      video.onended = finish
      video.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('礼物视频播放失败')) }
      const draw = (): void => {
        if (signal.aborted || video.ended) return
        try {
          if (video.readyState >= 2) {
            renderer!.draw(video)
            host.parentElement?.classList.add('is-playing')
          }
          frameIsVideo = 'requestVideoFrameCallback' in video
          frame = frameIsVideo ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
        } catch (error) { signal.removeEventListener('abort', abort); reject(error) }
      }
      void video.play().then(draw, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  } finally {
    video.onloadeddata = null; video.onerror = null; video.onended = null
    if (frameIsVideo) video.cancelVideoFrameCallback(frame)
    else cancelAnimationFrame(frame)
    video.pause(); video.removeAttribute('src'); video.load()
    URL.revokeObjectURL(blobUrl)
    renderer?.dispose()
    canvas.remove()
    host.parentElement?.classList.remove('is-playing')
  }
}

interface GiftEffectEntry { element: HTMLElement; payload: DanmakuPayload; ready: boolean }

/** 同时至多一个视频，同一卡片不因补价/连击/布局刷新重复播放。 */
export class OfficialGiftEffects {
  private attempted = new WeakMap<HTMLElement, Set<string>>()
  private active: { element: HTMLElement; controller: AbortController } | null = null

  update(entries: readonly GiftEffectEntry[], enabled: boolean): void {
    if (this.active && (!enabled || document.hidden || !entries.some(entry => entry.element === this.active!.element && entry.ready))) this.stop()
    if (!enabled || this.active || document.hidden) return
    for (const entry of entries) {
      const url = officialGiftUrl(entry.payload.giftVideo)
      const host = entry.element.querySelector<HTMLElement>('.gift-effect-host')
      if (!entry.ready || !url || !host) continue
      const played = this.attempted.get(entry.element) || new Set<string>()
      if (played.has(url)) continue
      played.add(url); this.attempted.set(entry.element, played)
      const controller = new AbortController()
      const active = { element: entry.element, controller }
      this.active = active
      const timer = setTimeout(() => controller.abort(), 20_000)
      void playVap(host, url, controller.signal).catch(() => {
        // 网络、GPU 或不支持格式都保持官方礼物图，不显示黑底和错误占位。
      }).finally(() => { clearTimeout(timer); if (this.active === active) this.active = null })
      break
    }
  }

  stop(): void { this.active?.controller.abort(); this.active = null }
  clear(): void { this.stop(); this.attempted = new WeakMap() }
}
