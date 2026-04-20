import { createContext, useContext, useReducer, type Dispatch } from 'react';

export type ExpandedPie = 'accounts' | 'products' | 'services' | null;

export interface CostFocusState {
  readonly environment: string | null;
  readonly hoveredEntity: string | null;
  readonly hoveredDimension: string | null;
  readonly expandedPie: ExpandedPie;
}

export type CostFocusAction =
  | { type: 'SET_ENVIRONMENT'; env: string | null }
  | { type: 'HOVER'; entity: string | null; dimension: string | null }
  | { type: 'TOGGLE_EXPAND'; pie: ExpandedPie }
  | { type: 'CLEAR_ALL' };

export const initialFocusState: CostFocusState = {
  environment: null,
  hoveredEntity: null,
  hoveredDimension: null,
  expandedPie: null,
};

export function costFocusReducer(state: CostFocusState, action: CostFocusAction): CostFocusState {
  switch (action.type) {
    case 'SET_ENVIRONMENT':
      return { ...state, environment: action.env };

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
