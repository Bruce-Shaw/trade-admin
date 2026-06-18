import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ComponentType,
} from 'react';
import { nanoid } from 'nanoid';

// ══════════════════════════════════════════════════════════════
//  Base Types
// ══════════════════════════════════════════════════════════════

/** Model creator — 任意签名的自定义 Hook */
export type ModelCreator = (...args: any[]) => any;

/** createModel 返回的模型描述对象 */
export interface ModelDesc<H extends ModelCreator = ModelCreator> {
  readonly modelId: string;
  readonly context: React.Context<ReturnType<H> | null>;
  readonly hook: H;
}

// ══════════════════════════════════════════════════════════════
//  Conditional Type Inference
//
//  根据 hook 参数签名自动推导 modelInitialData 中每个 key 的可选性：
//    无参 hook        → key 可选，值 never（实际不会使用）
//    全可选参数 hook  → key 可选，值 = Parameters 元组的 Partial
//    含必选参数 hook  → key 必填，值 = Parameters 元组的 Partial
// ══════════════════════════════════════════════════════════════

/**
 * 提取 hook 首个参数的类型；无参时为 undefined
 * @example
 *   HookArgs<(id: string) => S>       // string
 *   HookArgs<(id?: string) => S>      // string | undefined
 *   HookArgs<() => S>                 // undefined
 */
type HookArgs<H extends ModelCreator> = Parameters<H>[0];

/**
 * 判断 hook 是否存在必选参数
 *   () => S            → false（无参）
 *   (a?: string) => S  → false（全可选）
 *   (a: string) => S   → true（有必选）
 *   (a: string, b?: number) => S → true
 *
 * 原理：undefined 能否赋值给首个参数类型
 *   - 无参 → Parameters[0] = undefined → undefined extends undefined = true → 无必选
 *   - 可选 → Parameters[0] = T | undefined → undefined extends (T|undefined) = true → 无必选
 *   - 必选 → Parameters[0] = T → undefined extends T = false → 有必选
 */
type HasRequiredArgs<H extends ModelCreator> =
  undefined extends HookArgs<H> ? false : true;

/** 从 model map 中筛出「有必选参数」的 key 集合 */
type RequiredArgKeys<M extends Record<string, ModelDesc>> = {
  [K in keyof M]: HasRequiredArgs<M[K]['hook']> extends true ? K : never;
}[keyof M];

/** 从 model map 中筛出「无参 / 全可选参数」的 key 集合 */
type OptionalArgKeys<M extends Record<string, ModelDesc>> = {
  [K in keyof M]: HasRequiredArgs<M[K]['hook']> extends true ? never : K;
}[keyof M];

/**
 * 最终暴露给调用方的 modelInitialData 类型
 *
 * - 必选 key：必须提供，值为 hook 参数元组的 Partial（运行时与默认值浅合并）
 * - 可选 key：可省略，值为 hook 参数元组的 Partial
 *
 * @example
 *   // models = {
 *   //   counter: createModel(() => {...}),                // 无参
 *   //   user:    createModel((id: string) => {...}),      // 必选参数
 *   //   config:  createModel((mode?: 'a' | 'b') => {...}),// 可选参数
 *   // }
 *   // ↓ 推导结果
 *   // {
 *   //   user: Partial<[string]>;              ← 必填
 *   //   counter?: Partial<[]>;                ← 可选
 *   //   config?: Partial<['a' | 'b']>;        ← 可选
 *   // }
 */
export type ModelInitialData<M extends Record<string, ModelDesc>> =
  & Partial<Record<OptionalArgKeys<M>, Partial<Parameters<M[OptionalArgKeys<M>]['hook']>>>>
  & { [K in RequiredArgKeys<M>]: Partial<Parameters<M[K]['hook']>> };

// ══════════════════════════════════════════════════════════════
//  Runtime API
// ══════════════════════════════════════════════════════════════

/**
 * 创建模型描述对象
 *
 * 将自定义 Hook 包装为可被 bindModels / useContextModel 消费的描述对象。
 * 每次调用生成唯一 modelId（nanoid），并创建独立的 React Context。
 *
 * @example
 *   const useCounter = (initial?: number) => {
 *     const [count, setCount] = useState(initial ?? 0);
 *     return { count, setCount };
 *   };
 *   const CounterModel = createModel(useCounter);
 */
export function createModel<H extends ModelCreator>(hook: H): ModelDesc<H> {
  return {
    modelId: nanoid(),
    context: createContext<ReturnType<H> | null>(null),
    hook,
  };
}

/**
 * 安全消费模型状态
 *
 * 封装 useContext，若未在祖先节点找到对应 Provider 则抛出明确的错误信息。
 *
 * @example
 *   const { count, setCount } = useContextModel(CounterModel);
 */
export function useContextModel<H extends ModelCreator>(
  modelDesc: ModelDesc<H>,
): ReturnType<H> {
  const value = useContext(modelDesc.context);
  if (value === null) {
    throw new Error(
      `[context-model] Model "${modelDesc.modelId}" not found. ` +
        `Ensure the component is wrapped by the corresponding bindModels HOC.`,
    );
  }
  return value;
}

// ══════════════════════════════════════════════════════════════
//  bindModels HOC
// ══════════════════════════════════════════════════════════════

/** bindModels 内部使用的 model 映射条目 */
interface ModelEntry {
  key: string;       // models map 中的键名，用于查找 modelInitialData
  modelId: string;   // nanoid，用于 React key
  descriptor: ModelDesc;
}

/**
 * 将 defaults 和 overrides 两个参数数组做浅合并。
 * 同位上都是普通对象时展开合并，否则 overrides 优先。
 */
function mergeArgArrays(defaults: any[], overrides: any[]): any[] {
  const len = Math.max(defaults.length, overrides.length);
  const result: any[] = [];
  for (let i = 0; i < len; i++) {
    const d = defaults[i];
    const o = overrides[i];
    const bothPlainObj =
      o !== undefined &&
      typeof o === 'object' && o !== null && !Array.isArray(o) &&
      typeof d === 'object' && d !== null && !Array.isArray(d);

    result.push(bothPlainObj ? { ...d, ...o } : (o !== undefined ? o : d));
  }
  return result;
}

/**
 * 浅比较两个值是否相等。
 * - 非对象类型直接 === 比较
 * - 对象类型比较 key 数量 + 每个 key 的引用
 *
 * 用于稳定 context value：hook 每次渲染返回新对象，
 * 但只要内部属性引用没变（如 useState 的 setState 天然稳定），
 * 就复用旧引用，避免 consumer 无效重渲染。
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' || a === null ||
    typeof b !== 'object' || b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

/**
 * 单个 Provider 包装组件
 *
 * 职责：
 *   1. 将 hook 默认参数与运行时 modelInitialData 浅合并（运行时优先）
 *   2. 调用原始 hook 获取模型实例
 *   3. 用 useRef + shallowEqual 稳定 context value 引用，避免父组件 rerender 导致子组件无效重渲染
 */
function ModelProviderWrapper({
  descriptor,
  initialData,
  children,
}: {
  descriptor: ModelDesc;
  initialData: any;
  children: React.ReactNode;
}) {
  const { hook, context: Ctx } = descriptor;

  // 浅合并参数：defaults（空数组 = 无默认值）与运行时 initialData
  const mergedArgs = useMemo(
    () => mergeArgArrays([], initialData ?? []),
    [initialData],
  );

  // 调用 hook，获取模型实例
  const value = (hook as ModelCreator)(...mergedArgs);

  // 稳定 context value 引用：
  // hook 每次渲染都返回新对象，用 shallowEqual 判断内容是否真正变化，
  // 未变化则复用旧引用，避免 consumer 因引用变化而无效重渲染。
  const valueRef = useRef(value);
  if (!shallowEqual(valueRef.current, value)) {
    valueRef.current = value;
  }

  return <Ctx.Provider value={valueRef.current}>{children}</Ctx.Provider>;
}

/**
 * 核心 HOC：将多个模型绑定到目标组件
 *
 * 运行时行为：
 *   - 将多个 Context Provider 以嵌套方式包裹目标组件
 *   - 每个 Provider 内部使用 useRef + shallowEqual 稳定 context value，确保引用稳定
 *   - 参数合并策略：运行时 modelInitialData 与 hook 默认参数浅合并，运行时优先
 *
 * 类型行为：
 *   - 返回组件的 props = 原组件 props & { modelInitialData?: ModelInitialData<M> }
 *   - modelInitialData 内各 key 的可选性由对应 hook 的参数签名自动推导
 *
 * @example
 *   const useCounter = () => { ... };
 *   const useUser = (id: string) => { ... };
 *   const CounterModel = createModel(useCounter);
 *   const UserModel = createModel(useUser);
 *
 *   const Enhanced = bindModels(MyComponent, {
 *     counter: CounterModel,
 *     user: UserModel,
 *   });
 *
 *   // counter 无参 → 可不传；user 有必选参数 → 必传
 *   <Enhanced
 *     originalProp="value"
 *     modelInitialData={{ user: ['user-123'] }}
 *   />
 */
export function bindModels<
  P extends Record<string, any>,
  M extends Record<string, ModelDesc>,
>(
  Component: ComponentType<P>,
  models: M,
): ComponentType<P & { modelInitialData?: ModelInitialData<M> }> {
  // 一次性提取 entries，保证顺序稳定；保留 map key 用于查找 modelInitialData
  const entries: ModelEntry[] = Object.entries(models).map(([key, descriptor]) => ({
    key,
    modelId: descriptor.modelId,
    descriptor,
  }));

  type CombinedProps = P & { modelInitialData?: ModelInitialData<M> };

  function BoundComponent(props: CombinedProps) {
    const { modelInitialData, ...restProps } = props as any;

    // ── 构建 Provider 嵌套树 ──
    // 结构由 entries（模块级常量）决定，React 按 type+key 做 reconciliation，
    // 每个 ModelProviderWrapper 内部独立用 useRef + shallowEqual 稳定 context value，
    // 因此即使 JSX 对象重建，只要 value 引用不变，消费者就不会重渲染。
    let tree: React.ReactNode = <Component {...(restProps as P)} />;

    // 从最内层向外包裹，保证最外层 Provider 最先被渲染
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const initArgs =
        modelInitialData != null
          ? (modelInitialData as Record<string, any>)[entry.key]
          : undefined;

      tree = (
        <ModelProviderWrapper
          key={entry.modelId}
          descriptor={entry.descriptor}
          initialData={initArgs}
        >
          {tree}
        </ModelProviderWrapper>
      );
    }

    return <>{tree}</>;
  }

  // 调试友好的 displayName
  const modelNames = Object.keys(models).join(', ');
  BoundComponent.displayName = `bindModels(${
    Component.displayName || Component.name || 'Component'
  }, [${modelNames}])`;

  return BoundComponent;
}
