import { createContext, useContext, useReducer, type Dispatch } from 'react';

export type ServiceDrillState =
  | { readonly depth: 'none' }
  | { readonly depth: 'service'; readonly service: string }
  | { readonly depth: 'serviceFamily'; readonly service: string; readonly family: string };

export type ExpandedPie = 'accounts' | 'products' | 'services' | null;

export interface CostFocusState {
  readonly environment: string | null;
  readonly serviceDrill: ServiceDrillState;
  readonly hoveredEntity: string | null;
  readonly hoveredDimension: string | null;
  readonly expandedPie: ExpandedPie;
}

export type CostFocusAction =
  | { type: 'SET_ENVIRONMENT'; env: string | null }
  | { type: 'DRILL_SERVICE'; service: string }
  | { type: 'DRILL_SERVICE_FAMILY'; family: string }
  | { type: 'DRILL_UNWIND' }
  | { type: 'CLEAR_DRILL' }
  | { type: 'HOVER'; entity: string | null; dimension: string | null }
  | { type: 'TOGGLE_EXPAND'; pie: ExpandedPie }
  | { type: 'CLEAR_ALL' };

export const initialFocusState: CostFocusState = {
  environment: null,
  serviceDrill: { depth: 'none' },
  hoveredEntity: null,
  hoveredDimension: null,
  expandedPie: null,
};

export function costFocusReducer(state: CostFocusState, action: CostFocusAction): CostFocusState {
  switch (action.type) {
    case 'SET_ENVIRONMENT':
      return { ...state, environment: action.env };

    case 'DRILL_SERVICE':
      return { ...state, serviceDrill: { depth: 'service', service: action.service } };

    case 'DRILL_SERVICE_FAMILY':
      if (state.serviceDrill.depth !== 'service') return state;
      return { ...state, serviceDrill: { depth: 'serviceFamily', service: state.serviceDrill.service, family: action.family } };

    case 'DRILL_UNWIND':
      if (state.serviceDrill.depth === 'serviceFamily') {
        return { ...state, serviceDrill: { depth: 'service', service: state.serviceDrill.service } };
      }
      return { ...state, serviceDrill: { depth: 'none' } };

    case 'CLEAR_DRILL':
      return { ...state, serviceDrill: { depth: 'none' } };

    case 'HOVER':
      return { ...state, hoveredEntity: action.entity, hoveredDimension: action.dimension };

    case 'TOGGLE_EXPAND':
      return { ...state, expandedPie: state.expandedPie === action.pie ? null : action.pie };

    case 'CLEAR_ALL':
      return initialFocusState;
  }
}

const CostFocusContext = createContext(initialFocusState);
const CostFocusDispatchContext = createContext<Dispatch<CostFocusAction>>(() => { /* noop */ });

export const CostFocusProvider = CostFocusContext.Provider;
export const CostFocusDispatchProvider = CostFocusDispatchContext.Provider;

export function useCostFocus(): CostFocusState {
  return useContext(CostFocusContext);
}

export function useCostFocusDispatch(): Dispatch<CostFocusAction> {
  return useContext(CostFocusDispatchContext);
}

export function useCostFocusReducer(): [CostFocusState, Dispatch<CostFocusAction>] {
  return useReducer(costFocusReducer, initialFocusState);
}
