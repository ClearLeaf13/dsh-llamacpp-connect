import { describe, it, expect } from 'vitest'
import { parseModels, providerIdFor, baseUrlFor } from '../src/config-store.js'

describe('parseModels', () => {
  it('解析正常配置', () => {
    const raw = JSON.stringify({
      version: 1,
      models: [
        { id: 'balanced', name: 'Qwen 35B', alias: 'Qwen-35B', port: 8080, ctxK: 32, vision: false },
        { id: 'vl', name: 'Qwen VL', alias: 'Qwen-VL', port: 8081, ctxK: 64, mmproj: 'mmproj.gguf', vision: true },
      ],
    })
    const r = parseModels(raw)
    expect(r.models).toHaveLength(2)
    expect(r.skipped).toHaveLength(0)
    expect(r.models[0]).toMatchObject({ id: 'balanced', alias: 'Qwen-35B', port: 8080, ctxK: 32 })
    expect(r.models[1]!.vision).toBe(true)
  })

  it('JSON 损坏时返回空列表而不是抛错', () => {
    const r = parseModels('{ not json')
    expect(r.models).toHaveLength(0)
    expect(r.skipped[0]!.reason).toContain('JSON 解析失败')
  })

  it('models 不是数组时报错', () => {
    const r = parseModels(JSON.stringify({ models: 'oops' }))
    expect(r.models).toHaveLength(0)
    expect(r.skipped[0]!.reason).toContain('不是数组')
  })

  it('缺少 id 的条目被跳过', () => {
    const raw = JSON.stringify({ models: [{ name: 'no id', port: 8080 }] })
    const r = parseModels(raw)
    expect(r.models).toHaveLength(0)
    expect(r.skipped[0]!.reason).toContain('缺少 id')
  })

  it('端口无效的条目被跳过', () => {
    const raw = JSON.stringify({ models: [
      { id: 'a', port: 0 },
      { id: 'b', port: 99999 },
      { id: 'c', port: 'abc' },
    ] })
    const r = parseModels(raw)
    expect(r.models).toHaveLength(0)
    expect(r.skipped).toHaveLength(3)
  })

  it('端口重复的条目被跳过', () => {
    const raw = JSON.stringify({ models: [
      { id: 'a', port: 8080 },
      { id: 'b', port: 8080 },
    ] })
    const r = parseModels(raw)
    expect(r.models).toHaveLength(1)
    expect(r.skipped[0]!.reason).toContain('重复')
  })

  it('alias 缺失时退回 id', () => {
    const raw = JSON.stringify({ models: [{ id: 'my-model', port: 8080 }] })
    const r = parseModels(raw)
    expect(r.models[0]!.alias).toBe('my-model')
    expect(r.models[0]!.name).toBe('my-model')
  })

  it('ctxK 无效时用默认值 32', () => {
    const raw = JSON.stringify({ models: [
      { id: 'a', port: 8080, ctxK: -5 },
      { id: 'b', port: 8081, ctxK: 'x' },
    ] })
    const r = parseModels(raw)
    expect(r.models[0]!.ctxK).toBe(32)
    expect(r.models[1]!.ctxK).toBe(32)
  })

  it('只有 mmproj 才算真能看图', () => {
    const raw = JSON.stringify({ models: [
      // 标了 vision 但没有 mmproj：文件不完整，不能当多模态
      { id: 'a', port: 8080, vision: true },
      { id: 'b', port: 8081, vision: true, mmproj: 'x.gguf' },
    ] })
    const r = parseModels(raw)
    expect(r.models[0]!.vision).toBe(false)
    expect(r.models[1]!.vision).toBe(true)
  })

  it('空文件返回空列表', () => {
    const r = parseModels(JSON.stringify({ version: 1, models: [] }))
    expect(r.models).toHaveLength(0)
    expect(r.skipped).toHaveLength(0)
  })
})

describe('providerIdFor', () => {
  it('生成带前缀的合法 id', () => {
    expect(providerIdFor('balanced')).toBe('local-llm-balanced')
    expect(providerIdFor('My Model_v2')).toBe('local-llm-my-model-v2')
  })

  it('特殊字符被归一', () => {
    expect(providerIdFor('a@b#c')).toBe('local-llm-a-b-c')
  })

  it('空 id 有兜底', () => {
    expect(providerIdFor('')).toBe('local-llm-model')
    expect(providerIdFor('!!!')).toBe('local-llm-model')
  })
})

describe('baseUrlFor', () => {
  it('指向该模型独占的端口', () => {
    expect(baseUrlFor({ id: 'a', name: 'A', alias: 'A', port: 8080, ctxK: 32, vision: false }))
      .toBe('http://127.0.0.1:8080/v1')
  })
})
