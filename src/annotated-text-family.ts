import {
  assertFrontier, assertStructuralPoint,
} from './annotated-text.ts';
import type {
  Frontier, StructuralPoint, TextElement, TextState,
} from './annotated-text.ts';

const ROOT_ID = 'root';

export interface StructuralEndpoint {
  point: StructuralPoint;
  basisFrontier: Frontier;
}

function fail(message: string): never {
  throw new Error(`invalid annotated-text family: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value) as T;
}

function compareEntries(left: [string, TextElement], right: [string, TextElement]): number {
  const leftEl = left[1];
  const rightEl = right[1];
  if (leftEl.lamport !== rightEl.lamport) return rightEl.lamport - leftEl.lamport;
  const leftActor = leftEl.op[0];
  const rightActor = rightEl.op[0];
  return leftActor === rightActor
    ? rightEl.op[1] - leftEl.op[1]
    : (leftActor < rightActor ? 1 : -1);
}

export function rgaTraversal(checkpoint: TextState): Array<[string, TextElement]> {
  // Fast single-child storage avoids allocating a 1-element array and running a
  // Schwartzian sort for the 99.99% of elements in linear runs that have at
  // most one child.
  const singleChild = new Map<string, [string, TextElement]>();
  const multiChildren = new Map<string, Array<[string, TextElement]>>();
  for (const key in checkpoint.elements) {
    const element = checkpoint.elements[key];
    const entry: [string, TextElement] = [key, element];
    const parent = element.parent;
    const multi = multiChildren.get(parent);
    if (multi !== undefined) {
      multi.push(entry);
    } else {
      const existing = singleChild.get(parent);
      if (existing !== undefined) {
        singleChild.delete(parent);
        multiChildren.set(parent, [existing, entry]);
      } else {
        singleChild.set(parent, entry);
      }
    }
  }
  for (const list of multiChildren.values()) {
    list.sort(compareEntries);
  }

  const order: Array<[string, TextElement]> = [];
  const stack: Array<[string, TextElement]> = [];
  const rootSingle = singleChild.get(ROOT_ID);
  if (rootSingle !== undefined) {
    stack.push(rootSingle);
  } else {
    const rootMulti = multiChildren.get(ROOT_ID);
    if (rootMulti !== undefined) {
      for (let index = rootMulti.length - 1; index >= 0; index -= 1) stack.push(rootMulti[index]);
    }
  }
  while (stack.length > 0) {
    let entry: [string, TextElement] | undefined = stack.pop();
    while (entry !== undefined) {
      order.push(entry);
      const nextSingle = singleChild.get(entry[0]);
      if (nextSingle !== undefined) {
        entry = nextSingle;
        continue;
      }
      const nextMulti = multiChildren.get(entry[0]);
      if (nextMulti !== undefined) {
        for (let index = nextMulti.length - 1; index >= 1; index -= 1) stack.push(nextMulti[index]);
        entry = nextMulti[0];
        continue;
      }
      entry = undefined;
    }
  }
  return order;
}

export function assertStructuralEndpoint(endpoint: unknown): StructuralEndpoint {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    fail('endpoint must be a non-array object');
  }
  const raw = endpoint as Record<string, any>;
  const allowedKeys = ['point', 'basisFrontier'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`unknown endpoint key: ${key}`);
  }
  assertStructuralPoint(raw.point);
  assertFrontier(raw.basisFrontier);
  return deepFreeze({ point: raw.point, basisFrontier: raw.basisFrontier });
}
