import { test, expect } from 'bun:test'
import type { Canvas } from 'canvaskit-wasm'
import { SceneGraph } from '@open-pencil/scene-graph'
import { createImageCache } from '#core/canvas/images/cache'
import { ImagePreviewCache, previewEdge, useViewportImageRendering, type ImagePreview } from '#core/canvas/images/previews'
import { renderSceneToCanvas } from '#core/canvas/renderer/pipeline'

function image(width = 4, height = 4) {
  let deleted = 0
  return { width: () => width, height: () => height, delete: () => { deleted++ }, deleted: () => deleted }
}

test('decoded images respect the mipmap budget and rejected handles remain caller-owned', () => {
  const cache = createImageCache<ReturnType<typeof image>>(172)
  const a = image(), b = image(), c = image(), oversized = image(20, 20)
  const insert = (key: string, value: ReturnType<typeof image>) => cache.set(key, value)
  expect(insert('a', a)).toBe(true)
  expect(insert('b', b)).toBe(true)
  expect(cache.weight).toBe(172)
  cache.get('a')
  insert('c', c)
  expect(b.deleted()).toBe(1)
  expect(a.deleted()).toBe(0)
  expect(insert('large', oversized)).toBe(false)
  expect(oversized.deleted()).toBe(0)
  expect(cache.weight).toBe(172)
  cache.clear()
  cache.clear()
  expect(a.deleted()).toBe(1)
  expect(c.deleted()).toBe(1)
  expect(cache.weight).toBe(0)
})

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
const preview = (bytes = 5): ImagePreview => ({
  bytes: new Uint8Array(bytes),
  originalWidth: 1024,
  originalHeight: 512
})
test('preview decode is serialized, deduplicated, preserves source bytes and keeps old levels visible', async () => {
  const graph = new SceneGraph(),
    source = new Uint8Array([1, 2, 3])
  graph.images.set('a', source)
  const pending: Array<(value: ImagePreview) => void> = []
  let ready = 0,
    stopped = 0,
    calls = 0
  const cache = new ImagePreviewCache(() => {
    ready++
  }, 10)
  expect(cache.enabled).toBe(false)
  cache.setDecoder({
    decode: async (bytes) => {
      expect(bytes).toBe(source)
      calls++
      return new Promise((resolve) => {
        pending.push(resolve)
      })
    },
    destroy: () => {
      stopped++
    }
  })
  expect(cache.enabled).toBe(true)
  cache.get(graph, 'a', 128)
  cache.get(graph, 'a', 128)
  cache.get(graph, 'a', 256)
  expect(calls).toBe(1)
  pending.shift()?.(preview())
  await tick()
  expect(calls).toBe(2)
  expect(cache.get(graph, 'a', 256)?.key).toBe('a:preview:128')
  pending.shift()?.(preview(7))
  await tick()
  expect(cache.bytes).toBe(7)
  expect(cache.get(graph, 'a', 256)?.key).toBe('a:preview:256')
  expect([...source]).toEqual([1, 2, 3])
  expect(ready).toBe(2)
  cache.get(graph, 'a', 512)
  cache.destroy()
  expect(cache.enabled).toBe(false)
  pending.shift()?.(preview())
  await tick()
  expect(ready).toBe(2)
  expect(stopped).toBe(1)
  expect(cache.bytes).toBe(0)
  expect(cache.get(graph, 'a', 128)).toBeUndefined()
})
test('preview failure does not create a retry storm; document replacement discards stale completion', async () => {
  const a = new SceneGraph(),
    b = new SceneGraph()
  a.images.set('same', new Uint8Array([1]))
  b.images.set('same', new Uint8Array([2]))
  let calls = 0,
    ready = 0
  let complete: (value: ImagePreview) => void = () => undefined
  const cache = new ImagePreviewCache(() => {
    ready++
  })
  cache.setDecoder({
    decode: async () => {
      calls++
      if (calls === 1) throw new Error('bad image')
      return new Promise((resolve) => {
        complete = resolve
      })
    },
    destroy: () => undefined
  })
  cache.get(a, 'same', 128)
  await tick()
  cache.get(a, 'same', 128)
  expect(calls).toBe(1)
  cache.get(a, 'same', 256)
  cache.get(b, 'same', 128)
  complete(preview())
  await tick()
  expect(ready).toBe(0)
  complete(preview())
  await tick()
  expect(ready).toBe(1)
  expect(cache.get(b, 'same', 128)?.preview.bytes.length).toBe(5)
  cache.destroy()
})
test('large readonly documents select viewport previews and scale tiers include DPR', () => {
  const small = new SceneGraph(),
    large = new SceneGraph()
  for (let n = 0; n < 129; n++) large.images.set(String(n), new Uint8Array(1))
  expect(useViewportImageRendering(small)).toBe(false)
  expect(useViewportImageRendering(large)).toBe(true)
  expect(previewEdge({ width: 200, height: 100 }, 1, 2)).toBe(512)
  expect(previewEdge({ width: 10000, height: 100 }, 1)).toBe(2048)
})
test('full-resolution rendering disables previews and restores viewport/mode even on failure', () => {
  const graph = new SceneGraph(),
    page = graph.getPages()[0]
  graph.createNode('RECTANGLE', page.id)
  const viewport = { x: 1, y: 2, w: 3, h: 4 }
  const renderer = {
    viewportImageRendering: true,
    worldViewport: viewport,
    renderNode() {
      expect(this.viewportImageRendering).toBe(false)
      throw new Error('drawing failed')
    }
  }
  expect(() =>
    renderSceneToCanvas(
      renderer,
      {} as Canvas,
      graph,
      page.id
    )
  ).toThrow('drawing failed')
  expect(renderer.viewportImageRendering).toBe(true)
  expect(renderer.worldViewport).toBe(viewport)
})

test('pending work is bounded and oversized previews do not retry on each repaint', async () => {
  const graph = new SceneGraph()
  for (let i = 0; i < 100; i++) graph.images.set(String(i), new Uint8Array([i]))
  let calls = 0
  let complete: (value: ImagePreview) => void = () => undefined
  const cache = new ImagePreviewCache(() => undefined, 10)
  cache.setDecoder({
    decode: async () => { calls++; return new Promise((resolve) => { complete = resolve }) },
    destroy: () => undefined
  })
  for (let i = 0; i < 100; i++) cache.get(graph, String(i), 128)
  for (let i = 0; i < 64; i++) { complete(preview(20)); await tick() }
  expect(calls).toBe(64)
  expect(cache.bytes).toBeLessThanOrEqual(10)
  // The most recently rejected level remains remembered under the entry budget.
  cache.get(graph, '63', 128)
  expect(calls).toBe(64)
  cache.destroy()
})

test('adding images after first render enables the large-document policy', () => {
  const graph = new SceneGraph()
  expect(useViewportImageRendering(graph)).toBe(false)
  graph.images.set('large', new Uint8Array(33 * 1024 * 1024))
  expect(useViewportImageRendering(graph)).toBe(true)
})
