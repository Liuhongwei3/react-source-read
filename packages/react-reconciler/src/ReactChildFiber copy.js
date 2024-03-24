/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { ReactElement } from 'shared/ReactElementType';
import type {
  ReactPortal,
  Thenable,
  ReactContext,
  ReactDebugInfo,
} from 'shared/ReactTypes';
import type { Fiber } from './ReactInternalTypes';
import type { Lanes } from './ReactFiberLane';
import type { ThenableState } from './ReactFiberThenable';

import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {
  Placement,
  ChildDeletion,
  Forked,
  PlacementDEV,
} from './ReactFiberFlags';
import { enableBigIntSupport } from 'shared/ReactFeatureFlags';
import {
  getIteratorFn,
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_PORTAL_TYPE,
  REACT_LAZY_TYPE,
  REACT_CONTEXT_TYPE,
} from 'shared/ReactSymbols';
import {
  ClassComponent,
  HostRoot,
  HostText,
  HostPortal,
  Fragment,
} from './ReactWorkTags';
import isArray from 'shared/isArray';
import assign from 'shared/assign';
import { checkPropStringCoercion } from 'shared/CheckStringCoercion';
import { enableRefAsProp, disableStringRefs } from 'shared/ReactFeatureFlags';

import {
  createWorkInProgress,
  resetWorkInProgress,
  createFiberFromElement,
  createFiberFromFragment,
  createFiberFromText,
  createFiberFromPortal,
} from './ReactFiber';
import { isCompatibleFamilyForHotReloading } from './ReactFiberHotReloading';
import { getIsHydrating } from './ReactFiberHydrationContext';
import { pushTreeFork } from './ReactFiberTreeContext';
import { createThenableState, trackUsedThenable } from './ReactFiberThenable';
import { readContextDuringReconciliation } from './ReactFiberNewContext';
import React from 'react';

// This tracks the thenables that are unwrapped during reconcilation.
let thenableState: ThenableState | null = null;
let thenableIndexCounter: number = 0;

function mergeDebugInfo(
  outer: ReactDebugInfo | null,
  inner: ReactDebugInfo | null | void,
): ReactDebugInfo | null {
  if (!__DEV__) {
    return null;
  }
  if (inner == null) {
    return outer;
  } else if (outer === null) {
    return inner;
  } else {
    // If we have two debugInfo, we need to create a new one. This makes the array no longer
    // live so we'll miss any future updates if we received more so ideally we should always
    // do this after both have fully resolved/unsuspended.
    return outer.concat(inner);
  }
}

let didWarnAboutMaps;
let didWarnAboutGenerators;
let didWarnAboutStringRefs;
let ownerHasKeyUseWarning;
let ownerHasFunctionTypeWarning;
let ownerHasSymbolTypeWarning;
let warnForMissingKey = (child: mixed, returnFiber: Fiber) => { };

function isReactClass(type: any) {
  return type.prototype && type.prototype.isReactComponent;
}

function unwrapThenable<T>(thenable: Thenable<T>): T {
  const index = thenableIndexCounter;
  thenableIndexCounter += 1;
  if (thenableState === null) {
    thenableState = createThenableState();
  }
  return trackUsedThenable(thenableState, thenable, index);
}

function coerceRef(
  returnFiber: Fiber,
  current: Fiber | null,
  workInProgress: Fiber,
  element: ReactElement,
): void {
  let mixedRef;
  if (enableRefAsProp) {
    // TODO: This is a temporary, intermediate step. When enableRefAsProp is on,
    // we should resolve the `ref` prop during the begin phase of the component
    // it's attached to (HostComponent, ClassComponent, etc).
    const refProp = element.props.ref;
    mixedRef = refProp !== undefined ? refProp : null;
  } else {
    // Old behavior.
    mixedRef = element.ref;
  }

  let coercedRef;
  if (
    !disableStringRefs &&
    (typeof mixedRef === 'string' ||
      typeof mixedRef === 'number' ||
      typeof mixedRef === 'boolean')
  ) {
    coercedRef = convertStringRefToCallbackRef(
      returnFiber,
      current,
      element,
      mixedRef,
    );

    if (enableRefAsProp) {
      // When enableRefAsProp is on, we should always use the props as the
      // source of truth for refs. Not a field on the fiber.
      //
      // In the case of string refs, this presents a problem, because string
      // refs are not passed around internally as strings; they are converted to
      // callback refs. The ref used by the reconciler is not the same as the
      // one the user provided.
      //
      // But since this is a deprecated feature anyway, what we can do is clone
      // the props object and replace it with the internal callback ref. Then we
      // can continue to use the props object as the source of truth.
      //
      // This means the internal callback ref will leak into userspace. The
      // receiving component will receive a callback ref even though the parent
      // passed a string. Which is weird, but again, this is a deprecated
      // feature, and we're only leaving it around behind a flag so that Meta
      // can keep using string refs temporarily while they finish migrating
      // their codebase.
      const userProvidedProps = workInProgress.pendingProps;
      const propsWithInternalCallbackRef = assign({}, userProvidedProps);
      propsWithInternalCallbackRef.ref = coercedRef;
      workInProgress.pendingProps = propsWithInternalCallbackRef;
    }
  } else {
    coercedRef = mixedRef;
  }

  // TODO: If enableRefAsProp is on, we shouldn't use the `ref` field. We
  // should always read the ref from the prop.
  workInProgress.ref = coercedRef;
}

type ChildReconciler = (
  returnFiber: Fiber,
  currentFirstChild: Fiber | null,
  newChild: any,
  lanes: Lanes,
) => Fiber | null;

// This wrapper function exists because I expect to clone the code in each path
// to be able to optimize each path individually by branching early. This needs
// a compiler or we can do it manually. Helpers that don't need this branching
// live outside of this function.
function createChildReconciler(
  shouldTrackSideEffects: boolean,
): ChildReconciler {
  // 把需要删除的子节点放入父节点的 deletions，便于后续处理
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      // Noop.
      return;
    }
    const deletions = returnFiber.deletions;
    if (deletions === null) {
      returnFiber.deletions = [childToDelete];
      returnFiber.flags |= ChildDeletion;
    } else {
      deletions.push(childToDelete);
    }
  }

  // 删掉剩余的子节点，deleteChild 方法的数组版
  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): null {
    if (!shouldTrackSideEffects) {
      // Noop.
      return null;
    }

    // TODO: For the shouldClone case, this could be micro-optimized a bit by
    // assuming that after the first child we've already added everything.
    let childToDelete = currentFirstChild;
    while (childToDelete !== null) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
    return null;
  }

  function mapRemainingChildren(
    currentFirstChild: Fiber,
  ): Map<string | number, Fiber> {
    // Add the remaining children to a temporary map so that we can find them by
    // keys quickly. Implicit (null) keys get added to this set with their index
    // instead.
    const existingChildren: Map<string | number, Fiber> = new Map();

    let existingChild: null | Fiber = currentFirstChild;
    while (existingChild !== null) {
      if (existingChild.key !== null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    return existingChildren;
  }

  function useFiber(fiber: Fiber, pendingProps: mixed): Fiber {
    // We currently set sibling to null and index to 0 here because it is easy
    // to forget to do before returning it. E.g. for the single child case.
    const clone = createWorkInProgress(fiber, pendingProps);
    clone.index = 0;
    clone.sibling = null;
    return clone;
  }

  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    // 更新新的 fiber index 到 newIndex
    newFiber.index = newIndex;
    // 如果不需要跟踪副作用
    if (!shouldTrackSideEffects) {
      // 更新 flags
      // During hydration, the useId algorithm needs to know which fibers are
      // part of a list of children (arrays, iterators).
      newFiber.flags |= Forked;
      return lastPlacedIndex;
    }
    // 获取原来的 fiber
    const current = newFiber.alternate;
    if (current !== null) {
      const oldIndex = current.index;
      // 如果原来的 index 小于当前最新的不用移动的节点 index，说明在左侧，需要移动
      // A B C D
      // B A C D
      // B --> oldIndex = 1/lastPlacedIndex = 0 --> false --> not move --> 1
      // A --> oldIndex = 0/lastPlacedIndex = 1 --> true --> move --> 1
      // C --> oldIndex = 2/lastPlacedIndex = 1 --> false --> not move --> 2
      // D --> oldIndex = 3/lastPlacedIndex = 2 --> false --> not move
      if (oldIndex < lastPlacedIndex) {
        // This is a move.
        newFiber.flags |= Placement | PlacementDEV;
        return lastPlacedIndex;
      } else {
        // This item can stay in place.
        return oldIndex;
      }
    } else {
      // 原来的 fiber 为空表示这个节点不在旧的 Fiber tree 中，为一个新的，即插入
      // This is an insertion.
      newFiber.flags |= Placement | PlacementDEV;
      return lastPlacedIndex;
    }
  }

  function placeSingleChild(newFiber: Fiber): Fiber {
    // This is simpler for the single child case. We only need to do a
    // placement for inserting new children.
    if (shouldTrackSideEffects && newFiber.alternate === null) {
      newFiber.flags |= Placement | PlacementDEV;
    }
    return newFiber;
  }

  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ) {
    if (current === null || current.tag !== HostText) {
      // Insert
      const created = createFiberFromText(textContent, returnFiber.mode, lanes);
      created.return = returnFiber;

      return created;
    } else {
      // Update
      const existing = useFiber(current, textContent);
      existing.return = returnFiber;

      return existing;
    }
  }

  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    const elementType = element.type;
    if (elementType === REACT_FRAGMENT_TYPE) {
      return updateFragment(
        returnFiber,
        current,
        element.props.children,
        lanes,
        element.key,
        debugInfo,
      );
    }
    if (current !== null) {
      if (
        current.elementType === elementType ||
        // Keep this check inline so it only runs on the false path:
        (__DEV__
          ? isCompatibleFamilyForHotReloading(current, element)
          : false) ||
        // Lazy types should reconcile their resolved type.
        // We need to do this after the Hot Reloading check above,
        // because hot reloading has different semantics than prod because
        // it doesn't resuspend. So we can't let the call below suspend.
        (typeof elementType === 'object' &&
          elementType !== null &&
          elementType.$$typeof === REACT_LAZY_TYPE &&
          resolveLazy(elementType) === current.type)
      ) {
        // Move based on index
        const existing = useFiber(current, element.props);
        coerceRef(returnFiber, current, existing, element);
        existing.return = returnFiber;
        if (__DEV__) {
          existing._debugOwner = element._owner;
          existing._debugInfo = debugInfo;
        }
        return existing;
      }
    }
    // Insert
    const created = createFiberFromElement(element, returnFiber.mode, lanes);
    coerceRef(returnFiber, current, created, element);
    created.return = returnFiber;
    if (__DEV__) {
      created._debugInfo = debugInfo;
    }
    return created;
  }

  function createChild(
    returnFiber: Fiber,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      (enableBigIntSupport && typeof newChild === 'bigint')
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      const created = createFiberFromText(
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        returnFiber.mode,
        lanes,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const created = createFiberFromElement(
            newChild,
            returnFiber.mode,
            lanes,
          );
          coerceRef(returnFiber, null, created, newChild);
          created.return = returnFiber;

          return created;
        }
        case REACT_PORTAL_TYPE: {
          const created = createFiberFromPortal(
            newChild,
            returnFiber.mode,
            lanes,
          );
          created.return = returnFiber;

          return created;
        }
        case REACT_LAZY_TYPE: {
          const payload = newChild._payload;
          const init = newChild._init;
          return createChild(
            returnFiber,
            init(payload),
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo), // call merge after init
          );
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const created = createFiberFromFragment(
          newChild,
          returnFiber.mode,
          lanes,
          null,
        );
        created.return = returnFiber;

        return created;
      }
    }

    return null;
  }

  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: any,
    lanes: Lanes,
    debugInfo: null | ReactDebugInfo,
  ): Fiber | null {
    // Update the fiber if the keys match, otherwise return null.
    const key = oldFiber !== null ? oldFiber.key : null;

    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      (enableBigIntSupport && typeof newChild === 'bigint')
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      if (key !== null) {
        return null;
      }
      return updateTextNode(
        returnFiber,
        oldFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
        debugInfo,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          if (newChild.key === key) {
            return updateElement(
              returnFiber,
              oldFiber,
              newChild,
              lanes,
              mergeDebugInfo(debugInfo, newChild._debugInfo),
            );
          } else {
            return null;
          }
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        if (key !== null) {
          return null;
        }

        return updateFragment(
          returnFiber,
          oldFiber,
          newChild,
          lanes,
          null,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }
    }

    return null;
  }

  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      (enableBigIntSupport && typeof newChild === 'bigint')
    ) {
      // Text nodes don't have keys, so we neither have to check the old nor
      // new node for the key. If both are text nodes, they match.
      const matchedFiber = existingChildren.get(newIdx) || null;
      return updateTextNode(
        returnFiber,
        matchedFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
        debugInfo,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          return updateElement(
            returnFiber,
            matchedFiber,
            newChild,
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo),
          );
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const matchedFiber = existingChildren.get(newIdx) || null;
        return updateFragment(
          returnFiber,
          matchedFiber,
          newChild,
          lanes,
          null,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }
    }

    return null;
  }

  // 处理多节点的 diff 
  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: Array<any>,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // This algorithm can't optimize by searching from both ends since we
    // don't have backpointers on fibers. I'm trying to see how far we can get
    // with that model. If it ends up not being worth the tradeoffs, we can
    // add it later.

    // Even with a two ended optimization, we'd want to optimize for the case
    // where there are few changes and brute force the comparison instead of
    // going for the Map. It'd like to explore hitting that path first in
    // forward-only mode and only go for the Map once we notice that we need
    // lots of look ahead. This doesn't handle reversal as well as two ended
    // search but that's unusual. Besides, for the two ended optimization to
    // work on Iterables, we'd need to copy the whole set.

    // In this first iteration, we'll just live with hitting the bad case
    // (adding everything to a Map) in for every insert/move.

    // If you change this code, also update reconcileChildrenIterator() which
    // uses the same algorithm.

    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;
    // 第一轮循环
    // 遍历新旧节点，尝试复用旧的节点，更新相关值
    for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        // 暂存旧的下一个节点
        nextOldFiber = oldFiber.sibling;
      }
      // 尝试复用旧的节点
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        newChildren[newIdx],
        lanes,
        debugInfo,
      );
      // 如果尝试复用的节点都为 null，直接 break
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (oldFiber === null) {
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        // 如果旧的 fiber 存在且尝试复用的新的 fiber 又没有对应的 
        // alternate(暂时理解为没有真实 DOM)，就直接删除掉旧的 fiber
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      // 更新新的节点的位置 index，即最新的不需要移动的节点原来的 index
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (newIdx === newChildren.length) {
      // 新的节点列表遍历结束后，需要删除剩下的老节点
      // A B C D E --> B A C --> delete D E 节点
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      return resultingFirstChild;
    }

    // 如果原来的节点处理完
    if (oldFiber === null) {
      // 处理剩余的新节点列表中未处理的元素，即插入新节点
      // A B C --> A B C D E --> 循环处理 D E 节点
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(
          returnFiber,
          newChildren[newIdx],
          lanes,
          debugInfo,
        );
        if (newFiber === null) {
          continue;
        }
        // 更新 flags
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
        lanes,
        debugInfo,
      );
      if (newFiber !== null) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    return resultingFirstChild;
  }

  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
    lanes: Lanes,
  ): Fiber {
    // There's no need to check for keys on text nodes since we don't have a
    // way to define them.
    if (currentFirstChild !== null && currentFirstChild.tag === HostText) {
      // We already have an existing node so let's just update it and delete
      // the rest.
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      const existing = useFiber(currentFirstChild, textContent);
      existing.return = returnFiber;
      return existing;
    }
    // The existing first child is not a text node so we need to create one
    // and delete the existing ones.
    deleteRemainingChildren(returnFiber, currentFirstChild);
    const created = createFiberFromText(textContent, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  /**
   * 
   * @param {*} returnFiber 父级 fiber
   * @param {*} currentFirstChild 当前 fiber 的第一个子节点，当前 fiber 即指 currentFiber，即旧的
   * @param {*} element 新的子节点
   * @param {*} lanes 
   * @returns 新的第一个子节点
   */
  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    const key = element.key;
    let child = currentFirstChild;
    // 遍历处理：在旧节点中寻找可以复用的
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        const elementType = element.type;
        // 当 key、type 都相同时
        if (child.elementType === elementType) {// 比如都是 div div
          // 删掉 child 的相邻节点，不包括 child，因为此时满足复用条件
          deleteRemainingChildren(returnFiber, child.sibling);
          // 开始复用并返回
          const existing = useFiber(child, element.props);
          coerceRef(returnFiber, child, existing, element);
          // return 指向父节点
          existing.return = returnFiber;

          return existing;
        }
        // 当 key 相同、type 不相同时会直接删除剩余的子节点，包括当前的子节点
        // 如果 
        // Didn't match.
        deleteRemainingChildren(returnFiber, child);
        break;
      } else {
        // key 不相同时则直接不复用，删除节点
        deleteChild(returnFiber, child);
      }
      // 将 child 指向下一个相邻节点
      child = child.sibling;
    }

    // 遍历结束仍没有找到复用的节点，则删除所有的旧节点（while 循环已完成标记）并创建新节点、更新 return
    const created = createFiberFromElement(element, returnFiber.mode, lanes);
    coerceRef(returnFiber, currentFirstChild, created, element);
    created.return = returnFiber;
    return created;
  }

  // This API will tag the children with the side-effect of the reconciliation
  // itself. They will be added to the side-effect list as we pass through the
  // children and the parent.
  function reconcileChildFibersImpl(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // This function is not recursive.
    // If the top level item is an array, we treat it as a set of children,
    // not as a fragment. Nested arrays on the other hand will be treated as
    // fragment nodes. Recursion happens at the normal flow.

    // Handle object types
    if (typeof newChild === 'object' && newChild !== null) {
      // 如果只是新的只是单节点时
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE:
          return placeSingleChild(
            reconcileSingleElement(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes,
              mergeDebugInfo(debugInfo, newChild._debugInfo),
            ),
          );
      }

      // 如果新的是多节点时
      if (isArray(newChild)) {
        return reconcileChildrenArray(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }
    }

    // 如果新节点是字符、数字类型时
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      (enableBigIntSupport && typeof newChild === 'bigint')
    ) {
      return placeSingleChild(
        reconcileSingleTextNode(
          returnFiber,
          currentFirstChild,
          // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
          '' + newChild,
          lanes,
        ),
      );
    }

    // Remaining cases are all treated as empty.
    return deleteRemainingChildren(returnFiber, currentFirstChild);
  }

  function reconcileChildFibers(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    // This indirection only exists so we can reset `thenableState` at the end.
    // It should get inlined by Closure.
    thenableIndexCounter = 0;
    const firstChildFiber = reconcileChildFibersImpl(
      returnFiber,
      currentFirstChild,
      newChild,
      lanes,
      null, // debugInfo
    );
    thenableState = null;
    // Don't bother to reset `thenableIndexCounter` to 0 because it always gets
    // set at the beginning.
    return firstChildFiber;
  }

  return reconcileChildFibers;
}

export const reconcileChildFibers: ChildReconciler =
  createChildReconciler(true);
export const mountChildFibers: ChildReconciler = createChildReconciler(false);

export function resetChildReconcilerOnUnwind(): void {
  // On unwind, clear any pending thenables that were used.
  thenableState = null;
  thenableIndexCounter = 0;
}

export function cloneChildFibers(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  if (current !== null && workInProgress.child !== current.child) {
    throw new Error('Resuming work not yet implemented.');
  }

  if (workInProgress.child === null) {
    return;
  }

  let currentChild = workInProgress.child;
  let newChild = createWorkInProgress(currentChild, currentChild.pendingProps);
  workInProgress.child = newChild;

  newChild.return = workInProgress;
  while (currentChild.sibling !== null) {
    currentChild = currentChild.sibling;
    newChild = newChild.sibling = createWorkInProgress(
      currentChild,
      currentChild.pendingProps,
    );
    newChild.return = workInProgress;
  }
  newChild.sibling = null;
}

// Reset a workInProgress child set to prepare it for a second pass.
export function resetChildFibers(workInProgress: Fiber, lanes: Lanes): void {
  let child = workInProgress.child;
  while (child !== null) {
    resetWorkInProgress(child, lanes);
    child = child.sibling;
  }
}
