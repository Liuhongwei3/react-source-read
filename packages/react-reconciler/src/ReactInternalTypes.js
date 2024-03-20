/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  RefObject,
  ReactContext,
  StartTransitionOptions,
  Wakeable,
  Usable,
  ReactFormState,
  Awaited,
  ReactDebugInfo,
} from 'shared/ReactTypes';
import type { WorkTag } from './ReactWorkTags';
import type { TypeOfMode } from './ReactTypeOfMode';
import type { Flags } from './ReactFiberFlags';
import type { Lane, Lanes, LaneMap } from './ReactFiberLane';
import type { RootTag } from './ReactRootTags';
import type {
  Container,
  TimeoutHandle,
  NoTimeout,
  SuspenseInstance,
  TransitionStatus,
} from './ReactFiberConfig';
import type { Cache } from './ReactFiberCacheComponent';
import type {
  TracingMarkerInstance,
  Transition,
} from './ReactFiberTracingMarkerComponent';
import type { ConcurrentUpdate } from './ReactFiberConcurrentUpdates';

// Unwind Circular: moved from ReactFiberHooks.old
export type HookType =
  | 'useState'
  | 'useReducer'
  | 'useContext'
  | 'useRef'
  | 'useEffect'
  | 'useEffectEvent'
  | 'useInsertionEffect'
  | 'useLayoutEffect'
  | 'useCallback'
  | 'useMemo'
  | 'useImperativeHandle'
  | 'useDebugValue'
  | 'useDeferredValue'
  | 'useTransition'
  | 'useSyncExternalStore'
  | 'useId'
  | 'useCacheRefresh'
  | 'useOptimistic'
  | 'useFormState';

export type ContextDependency<T> = {
  context: ReactContext<T>,
  next: ContextDependency<mixed> | null,
  memoizedValue: T,
  ...
};

export type Dependencies = {
  lanes: Lanes,
  firstContext: ContextDependency<mixed> | null,
  ...
};

export type MemoCache = {
  data: Array<Array<any>>,
  index: number,
};

// A Fiber is work on a Component that needs to be done or was done. There can
// be more than one per component.
export type Fiber = {
  // These first fields are conceptually members of an Instance. This used to
  // be split into a separate type and intersected with the other Fiber fields,
  // but until Flow fixes its intersection bugs, we've merged them into a
  // single type.

  // An Instance is shared between all versions of a component. We can easily
  // break this out into a separate object to avoid copying so much to the
  // alternate versions of the tree. We put this on a single object for now to
  // minimize the number of objects created during the initial render.

  // Tag identifying the type of fiber. 比如 function/class/fragment/ForwardRef/...
  tag: WorkTag,

  // Unique identifier of this child. comp key 唯一值
  key: null | string,

  // The value of element.type which is used to preserve the identity during
  // reconciliation of this child.
  // 节点类型：div/span/...
  elementType: any,

  // The resolved function/class/ associated with this fiber.
  type: any,

  // The local state associated with this fiber.
  stateNode: any,

  // Conceptual aliases
  // parent : Instance -> return The parent happens to be the same as the
  // return fiber since we've merged the fiber and instance.

  // Remaining fields belong to Fiber

  // The Fiber to return to after finishing processing this one.
  // This is effectively the parent, but there can be multiple parents (two)
  // so this is only the parent of the thing we're currently processing.
  // It is conceptually the same as the return address of a stack frame.
  // 其父节点
  return: Fiber | null,

  // Singly Linked List Tree Structure.
  // 其子节点
  child: Fiber | null,
  // 其兄弟节点
  sibling: Fiber | null,
  index: number,

  // The ref last used to attach this node.
  // I'll avoid adding an owner field for prod and model that as functions.
  ref:
  | null
  | (((handle: mixed) => void) & { _stringRef: ?string, ... })
  | RefObject,

  refCleanup: null | (() => void),

  // props && state
  // Input is the data coming into process this fiber. Arguments. Props.
  pendingProps: any, // This type will be more specific once we overload the tag.
  memoizedProps: any, // The props used to create the output.

  // A queue of state updates and callbacks.
  updateQueue: mixed,

  // The state used to create the output
  memoizedState: any,

  // Dependencies (contexts, events) for this fiber, if it has any
  dependencies: Dependencies | null,

  // Bitfield that describes properties about the fiber and its subtree. E.g.
  // the ConcurrentMode flag indicates whether the subtree should be async-by-
  // default. When a fiber is created, it inherits the mode of its
  // parent. Additional flags can be set at creation time, but after that the
  // value should remain unchanged throughout the fiber's lifetime, particularly
  // before its child fibers are created.
  // 描述 Fiber 工作模式的标志（例如 Concurrent 模式、StrictLegacyMode 模式等）
  mode: TypeOfMode,

  // Effect
  // 存储副作用的标记，例如DOM更新、生命周期方法调用等。React会积累这些副作用，然后在 commit 阶段一次性执行，从而提高效率
  //   假设有两种标识符：
  // Placement (表示新插入的子节点)：0b001
  // Update (表示子节点已更新)：0b010

  // A
  // ├─ B (Update)
  // │   └─ D (Placement)
  // └─ C
  //    └─ E

  // 这个例子里，计算逻辑是这样：
  // 1、检查到A的flags没有副作用，直接复用，但subtreeFlags有副作用，那么递归检查B和C
  // 2、检查到B的flags有复用，更新B，subtreeFlags也有副作用，则继续检查D
  // 3、检查到C的flags没有副作用，subtreeFlags也没有副作用，那么直接复用C和E
  // 如果节点更多，则以此类推。
  // 这样的计算方式可以减少递归那些没有副作用的子树或节点，所以比以前的版本全部递归的算法要高效
  flags: Flags,
  subtreeFlags: Flags,
  // 要删除的子节点
  deletions: Array<Fiber> | null,

  // lane 模型相关（主要是调度时）
  lanes: Lanes,
  childLanes: Lanes,

  // This is a pooled version of a Fiber. Every fiber that gets updated will
  // eventually have a pair. There are cases when we can clean up pairs to save
  // memory if we need to.
  // current tree <--> [work in progress] tree 互相指向
  // 更新时只需要将 fiberRoot 从 current tree 切换到 WIP tree，此时 WIP tree --> current tree
  alternate: Fiber | null,

  // Time spent rendering this Fiber and its descendants for the current update.
  // This tells us how well the tree makes use of sCU for memoization.
  // It is reset to 0 each time we render and only updated when we don't bailout.
  // This field is only set when the enableProfilerTimer flag is enabled.
  actualDuration?: number,

  // If the Fiber is currently active in the "render" phase,
  // This marks the time at which the work began.
  // This field is only set when the enableProfilerTimer flag is enabled.
  actualStartTime?: number,

  // Duration of the most recent render time for this Fiber.
  // This value is not updated when we bailout for memoization purposes.
  // This field is only set when the enableProfilerTimer flag is enabled.
  selfBaseDuration?: number,

  // Sum of base times for all descendants of this Fiber.
  // This value bubbles up during the "complete" phase.
  // This field is only set when the enableProfilerTimer flag is enabled.
  treeBaseDuration?: number,

  // Conceptual aliases
  // workInProgress : Fiber ->  alternate The alternate used for reuse happens
  // to be the same as work in progress.
  // __DEV__ only

  _debugInfo?: ReactDebugInfo | null,
  _debugOwner?: Fiber | null,
  _debugIsCurrentlyTiming?: boolean,
  _debugNeedsRemount?: boolean,

  // Used to verify that the order of hooks does not change between renders.
  _debugHookTypes?: Array<HookType> | null,
};

type BaseFiberRootProperties = {
  // The type of root (legacy, batched, concurrent, etc.)
  tag: RootTag,

  // Any additional information from the host associated with this root.
  containerInfo: Container,
  // Used only by persistent updates.
  pendingChildren: any,
  // The currently active root fiber. This is the mutable root of the tree.
  current: Fiber,

  pingCache: WeakMap<Wakeable, Set<mixed>> | Map<Wakeable, Set<mixed>> | null,

  // A finished work-in-progress HostRoot that's ready to be committed.
  finishedWork: Fiber | null,
  // Timeout handle returned by setTimeout. Used to cancel a pending timeout, if
  // it's superseded by a new one.
  timeoutHandle: TimeoutHandle | NoTimeout,
  // When a root has a pending commit scheduled, calling this function will
  // cancel it.
  // TODO: Can this be consolidated with timeoutHandle?
  cancelPendingCommit: null | (() => void),
  // Top context object, used by renderSubtreeIntoContainer
  context: Object | null,
  pendingContext: Object | null,

  // Used to create a linked list that represent all the roots that have
  // pending work scheduled on them.
  next: FiberRoot | null,

  // Node returned by Scheduler.scheduleCallback. Represents the next rendering
  // task that the root will work on.
  callbackNode: any,
  callbackPriority: Lane,
  expirationTimes: LaneMap<number>,
  hiddenUpdates: LaneMap<Array<ConcurrentUpdate> | null>,

  pendingLanes: Lanes,
  suspendedLanes: Lanes,
  pingedLanes: Lanes,
  expiredLanes: Lanes,
  errorRecoveryDisabledLanes: Lanes,
  shellSuspendCounter: number,

  finishedLanes: Lanes,

  entangledLanes: Lanes,
  entanglements: LaneMap<Lanes>,

  pooledCache: Cache | null,
  pooledCacheLanes: Lanes,

  // TODO: In Fizz, id generation is specific to each server config. Maybe we
  // should do this in Fiber, too? Deferring this decision for now because
  // there's no other place to store the prefix except for an internal field on
  // the public createRoot object, which the fiber tree does not currently have
  // a reference to.
  identifierPrefix: string,

  onRecoverableError: (
    error: mixed,
    errorInfo: { digest?: ?string, componentStack?: ?string },
  ) => void,

  formState: ReactFormState<any, any> | null,
};

// The following attributes are only used by DevTools and are only present in DEV builds.
// They enable DevTools Profiler UI to show which Fiber(s) scheduled a given commit.
type UpdaterTrackingOnlyFiberRootProperties = {
  memoizedUpdaters: Set<Fiber>,
  pendingUpdatersLaneMap: LaneMap<Set<Fiber>>,
};

export type SuspenseHydrationCallbacks = {
  onHydrated?: (suspenseInstance: SuspenseInstance) => void,
  onDeleted?: (suspenseInstance: SuspenseInstance) => void,
  ...
};

// The follow fields are only used by enableSuspenseCallback for hydration.
type SuspenseCallbackOnlyFiberRootProperties = {
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
};

export type TransitionTracingCallbacks = {
  onTransitionStart?: (transitionName: string, startTime: number) => void,
  onTransitionProgress?: (
    transitionName: string,
    startTime: number,
    currentTime: number,
    pending: Array<{ name: null | string }>,
  ) => void,
  onTransitionIncomplete?: (
    transitionName: string,
    startTime: number,
    deletions: Array<{
      type: string,
      name?: string | null,
      endTime: number,
    }>,
  ) => void,
  onTransitionComplete?: (
    transitionName: string,
    startTime: number,
    endTime: number,
  ) => void,
  onMarkerProgress?: (
    transitionName: string,
    marker: string,
    startTime: number,
    currentTime: number,
    pending: Array<{ name: null | string }>,
  ) => void,
  onMarkerIncomplete?: (
    transitionName: string,
    marker: string,
    startTime: number,
    deletions: Array<{
      type: string,
      name?: string | null,
      endTime: number,
    }>,
  ) => void,
  onMarkerComplete?: (
    transitionName: string,
    marker: string,
    startTime: number,
    endTime: number,
  ) => void,
};

// The following fields are only used in transition tracing in Profile builds
type TransitionTracingOnlyFiberRootProperties = {
  transitionCallbacks: null | TransitionTracingCallbacks,
  transitionLanes: Array<Set<Transition> | null>,
  // Transitions on the root can be represented as a bunch of tracing markers.
  // Each entangled group of transitions can be treated as a tracing marker.
  // It will have a set of pending suspense boundaries. These transitions
  // are considered complete when the pending suspense boundaries set is
  // empty. We can represent this as a Map of transitions to suspense
  // boundary sets
  incompleteTransitions: Map<Transition, TracingMarkerInstance>,
};

// Exported FiberRoot type includes all properties,
// To avoid requiring potentially error-prone :any casts throughout the project.
// The types are defined separately within this file to ensure they stay in sync.
export type FiberRoot = {
  ...BaseFiberRootProperties,
  ...SuspenseCallbackOnlyFiberRootProperties,
  ...UpdaterTrackingOnlyFiberRootProperties,
  ...TransitionTracingOnlyFiberRootProperties,
  ...
};

type BasicStateAction<S> = (S => S) | S;
type Dispatch<A> = A => void;

export type Dispatcher = {
  use: <T>(Usable<T>) => T,
    readContext < T > (context: ReactContext < T >): T,
      useState < S > (initialState: (() => S) | S): [S, Dispatch < BasicStateAction < S >>],
        useReducer < S, I, A > (
          reducer: (S, A) => S,
            initialArg: I,
              init ?: (I) => S,
  ): [S, Dispatch < A >],
  useContext < T > (context: ReactContext < T >): T,
    useRef < T > (initialValue: T): { current: T },
useEffect(
  create: () => (() => void) | void,
  deps: Array < mixed > | void | null,
): void,
  useEffectEvent ?: <Args, F: (...Array<Args>) => mixed > (callback: F) => F,
    useInsertionEffect(
      create: () => (() => void) | void,
      deps: Array < mixed > | void | null,
    ): void,
      useLayoutEffect(
        create: () => (() => void) | void,
        deps: Array < mixed > | void | null,
      ): void,
        useCallback < T > (callback: T, deps: Array < mixed > | void | null): T,
          useMemo < T > (nextCreate: () => T, deps: Array < mixed > | void | null): T,
            useImperativeHandle < T > (
              ref: { current: T | null } | ((inst: T | null) => mixed) | null | void,
                create: () => T,
                  deps: Array < mixed > | void | null,
  ): void,
  useDebugValue < T > (value: T, formatterFn: ?(value: T) => mixed): void,
    useDeferredValue < T > (value: T, initialValue ?: T): T,
      useTransition(): [
        boolean,
        (callback: () => void, options?: StartTransitionOptions) => void,
      ],
        useSyncExternalStore < T > (
          subscribe: (() => void) => () => void,
            getSnapshot: () => T,
              getServerSnapshot ?: () => T,
  ): T,
  useId(): string,
    useCacheRefresh ?: () => <T>(?() => T, ?T) => void,
  useMemoCache?: (size: number) => Array<any>,
  useHostTransitionStatus?: () => TransitionStatus,
        useOptimistic?: <S, A>(
        passthrough: S,
    reducer: ?(S, A) => S,
  ) => [S, (A) => void],
        useFormState?: <S, P>(
        action: (Awaited<S>, P) => S,
          initialState: Awaited<S>,
            permalink?: string,
  ) => [Awaited<S>, (P) => void, boolean],
};

              export type CacheDispatcher = {
                getCacheSignal: () => AbortSignal,
              getCacheForType: <T>(resourceType: () => T) => T,
};
