import { emoticonMap, splitEmoticons, type DouyuEmoticon } from '../shared/emoticons'

export class EmoticonRenderer {
  private catalog = emoticonMap([])
  private readonly rendered = new WeakMap<HTMLElement, string>()
  constructor(private readonly onLayout: () => void) {}

  setCatalog(items: readonly DouyuEmoticon[]): void { this.catalog = emoticonMap(items) }

  render(element: HTMLElement, text: string, enabled: boolean): void {
    const parts = splitEmoticons(text, this.catalog, enabled)
    const signature = JSON.stringify(parts.map(part => [part.text, part.emoticon?.url]))
    if (this.rendered.get(element) === signature) return
    this.rendered.set(element, signature)
    const fragment = document.createDocumentFragment()
    for (const part of parts) {
      if (!part.emoticon) { fragment.append(document.createTextNode(part.text)); continue }
      const image = document.createElement('img')
      image.className = 'chat-emoticon'
      image.alt = part.text
      image.title = part.text
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.draggable = false
      image.addEventListener('error', () => {
        if (!image.parentNode) return
        image.replaceWith(document.createTextNode(part.text))
        this.onLayout()
      }, { once: true })
      image.src = part.emoticon.url
      fragment.append(image)
    }
    element.replaceChildren(fragment)
    this.onLayout()
  }
}
