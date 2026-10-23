import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ButtonTooltip } from '../components/ui/tooltip.js';
import { Popover, PopoverContent } from '../components/ui/popover.js';

function renderTooltip(suppressed?: boolean): { user: ReturnType<typeof userEvent.setup>; button: HTMLElement; rerender: (suppressed: boolean) => void } {
  const user = userEvent.setup();
  const tree = (s: boolean | undefined): React.JSX.Element => (
    <ButtonTooltip name="Data sync" description="Billing data downloads" suppressed={s}>
      <button type="button" aria-label="Data sync">x</button>
    </ButtonTooltip>
  );
  const { rerender } = render(tree(suppressed));
  return {
    user,
    button: screen.getByRole('button', { name: 'Data sync' }),
    rerender: (s) => { rerender(tree(s)); },
  };
}

describe('ButtonTooltip', () => {
  it('shows the name and line on hover, with no delay', async () => {
    const { user, button } = renderTooltip();
    await user.hover(button);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Data sync')).toBeDefined();
    expect(within(tip).getByText('Billing data downloads')).toBeDefined();
  });

  it('shows on keyboard focus and Escape dismisses it', async () => {
    const { user } = renderTooltip();
    await user.tab();
    expect(await screen.findByRole('tooltip')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays shut when focus comes back by code after a mouse action', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ButtonTooltip name="Data sync" description="Billing data downloads">
          <button type="button" aria-label="Data sync">x</button>
        </ButtonTooltip>
        <button type="button">elsewhere</button>
      </>,
    );
    // A menu or modal closed with the mouse hands focus back to its opener.
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    act(() => { screen.getByRole('button', { name: 'Data sync' }).focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays shut when focus comes back after a bare modifier key, as on Cmd+Tab', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ButtonTooltip name="Data sync" description="Billing data downloads">
          <button type="button" aria-label="Data sync">x</button>
        </ButtonTooltip>
        <button type="button">elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    await user.keyboard('{Meta}');
    act(() => { screen.getByRole('button', { name: 'Data sync' }).focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on click and stays closed while the pointer stays on the button', async () => {
    const { user, button } = renderTooltip();
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toBeDefined();
    await user.click(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.pointer({ target: button, coords: { x: 3, y: 3 } });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('never opens while suppressed', async () => {
    const { user, button, rerender } = renderTooltip(true);
    await user.hover(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(false);
    await user.unhover(button);
    await user.tab();
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toBeDefined();
  });

  it('does not come back when suppression lifts, if it was open as it began', async () => {
    const { user, button, rerender } = renderTooltip(false);
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toBeDefined();
    // The button's popover opens (suppressing it) and later closes again.
    rerender(true);
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(false);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not add a native title', async () => {
    const { user, button } = renderTooltip();
    expect(button.getAttribute('title')).toBeNull();
    await user.hover(button);
    expect(button.getAttribute('title')).toBeNull();
  });

  it('sizes its arrow, so it draws', async () => {
    const { user, button } = renderTooltip();
    await user.hover(button);
    const arrow = (await screen.findByRole('tooltip')).querySelector('[data-card-arrow]');
    expect(arrow?.getAttribute('width')).toBe('12');
    expect(arrow?.getAttribute('height')).toBe('6');
  });

  it('cannot take the pointer', async () => {
    const { user, button } = renderTooltip();
    await user.hover(button);
    expect((await screen.findByRole('tooltip')).classList.contains('pointer-events-none')).toBe(true);
  });
});

describe('PopoverContent arrow', () => {
  it('draws an arrow only when asked', () => {
    const { unmount } = render(<Popover open><PopoverContent arrow>with</PopoverContent></Popover>);
    expect(screen.getByText('with').querySelector('[data-card-arrow]')).not.toBeNull();
    unmount();
    render(<Popover open><PopoverContent>without</PopoverContent></Popover>);
    expect(screen.getByText('without').querySelector('[data-card-arrow]')).toBeNull();
  });
});
