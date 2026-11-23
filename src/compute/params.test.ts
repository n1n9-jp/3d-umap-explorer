import { describe, expect, it } from 'vitest';
import { describeComputed, describePrecomputed, embeddingStatusText, paramsKey, parseUrlParams, searchWithParams, validParams } from './params';
import { parsePanelInputs } from '../app/umapPanel';

describe('validParams', () => {
  it('範囲を検査し、min_dist を小数第 2 位に丸める', () => {
    expect(validParams(15, 0.1, 42)).toEqual({ nNeighbors: 15, minDist: 0.1, seed: 42 });
    expect(validParams(5, 0, 0)).toEqual({ nNeighbors: 5, minDist: 0, seed: 0 });
    expect(validParams(50, 0.99, 2147483647)).not.toBeNull();
    expect(validParams(15, 0.123, 1)!.minDist).toBe(0.12);
    expect(validParams(4, 0.1, 1)).toBeNull();
    expect(validParams(51, 0.1, 1)).toBeNull();
    expect(validParams(15.5, 0.1, 1)).toBeNull();
    expect(validParams(15, 1, 1)).toBeNull();
    expect(validParams(15, -0.01, 1)).toBeNull();
    expect(validParams(15, 0.1, -1)).toBeNull();
    expect(validParams(15, 0.1, 1.5)).toBeNull();
    expect(validParams(31, 0.1, 1, 30)).toBeNull();
  });
});

describe('URL の nn・md・seed', () => {
  it('読む', () => {
    expect(parseUrlParams('?data=mnist&nn=30&md=0.5&seed=7')).toEqual({ nNeighbors: 30, minDist: 0.5, seed: 7 });
    expect(parseUrlParams('?data=mnist')).toBeNull();
    expect(parseUrlParams('?nn=30&md=0.5')).toHaveProperty('error');
    expect(parseUrlParams('?nn=3&md=0.5&seed=1')).toHaveProperty('error');
    expect(parseUrlParams('?nn=x&md=0.5&seed=1')).toHaveProperty('error');
  });
  it('書く・外す（ほかのパラメータは保つ）', () => {
    const p = { nNeighbors: 30, minDist: 0.5, seed: 7 };
    expect(searchWithParams('?data=mnist&pos=1,2,3', p)).toBe('?data=mnist&pos=1,2,3&nn=30&md=0.5&seed=7');
    expect(searchWithParams('?data=data/mnist/&nn=30&md=0.5&seed=7', null)).toBe('?data=data/mnist/');
    expect(searchWithParams('?nn=1&md=0&seed=1', null)).toBe('');
    expect(parseUrlParams(searchWithParams('', p))).toEqual(p);
  });
  it('鍵と説明', () => {
    expect(paramsKey({ nNeighbors: 15, minDist: 0.1, seed: 42 })).toBe('nn=15&md=0.10&seed=42');
    expect(describeComputed({ nNeighbors: 15, minDist: 0.1, seed: 42 })).toBe('ブラウザで計算（近傍数 15・min_dist 0.10・種 42・200 エポック）');
    expect(describePrecomputed({ library: 'umap-learn 0.6.0', nNeighbors: 15, minDist: 0.1, randomState: 42 }))
      .toBe('事前計算（umap-learn 0.6.0・近傍数 15・min_dist 0.10・種 42）');
    expect(describePrecomputed(undefined)).toBe('事前計算');
    expect(embeddingStatusText({ kind: 'precomputed', umap: { library: 'x', nNeighbors: 15, minDist: 0.1, randomState: 42 } }))
      .toBe('埋め込み: 事前計算（近傍数 15・min_dist 0.10・種 42）');
    expect(embeddingStatusText({ kind: 'computed', params: { nNeighbors: 5, minDist: 0, seed: 1 } }))
      .toBe('埋め込み: ブラウザで計算（近傍数 5・min_dist 0.00・種 1）');
  });
});

describe('parsePanelInputs', () => {
  it('入力欄の文字列を検査する', () => {
    expect(parsePanelInputs('20', '0.25', '3', 51)).toEqual({ params: { nNeighbors: 20, minDist: 0.25, seed: 3 } });
    expect(parsePanelInputs('', '0.25', '3', 51)).toMatchObject({ field: 'nn' });
    expect(parsePanelInputs('4', '0.25', '3', 51)).toMatchObject({ field: 'nn' });
    expect(parsePanelInputs('20', '1.5', '3', 51)).toMatchObject({ field: 'md' });
    expect(parsePanelInputs('20', '0.2', '-1', 51)).toMatchObject({ field: 'seed' });
    expect(parsePanelInputs('40', '0.2', '1', 30)).toMatchObject({ field: 'nn' });
  });
});
