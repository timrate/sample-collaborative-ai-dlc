import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HelpTip } from './HelpTip';
import { HelpMenu } from './HelpMenu';
import { DOCS_BASE_URL } from '@/lib/docs';
import { HELP_TOPICS } from '@/lib/help-topics';

describe('HelpTip', () => {
  it('opens the topic with a link to its guide section', async () => {
    const user = userEvent.setup();
    render(<HelpTip topic="compose.scope" />);

    expect(screen.queryByText(HELP_TOPICS['compose.scope'].body)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Help: Scope' }));

    expect(screen.getByText(HELP_TOPICS['compose.scope'].body)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /read the guide/i });
    expect(link).toHaveAttribute(
      'href',
      `${DOCS_BASE_URL}using-the-platform/creating-intents/#scope`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens from the keyboard and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<HelpTip topic="intent.prompt" />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Help: Prompt' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText(HELP_TOPICS['intent.prompt'].body)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText(HELP_TOPICS['intent.prompt'].body)).not.toBeInTheDocument();
  });

  it('does not submit an enclosing form', async () => {
    const user = userEvent.setup();
    let submitted = false;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted = true;
        }}
      >
        <HelpTip topic="intent.title" />
      </form>,
    );

    await user.click(screen.getByRole('button', { name: 'Help: Title' }));
    expect(submitted).toBe(false);
  });
});

describe('HelpMenu', () => {
  it('lists the guides and the documentation home', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);

    await user.click(screen.getByRole('button', { name: 'Help and documentation' }));

    expect(screen.getByRole('menuitem', { name: 'Creating intents' })).toHaveAttribute(
      'href',
      `${DOCS_BASE_URL}using-the-platform/creating-intents/`,
    );
    expect(screen.getByRole('menuitem', { name: /all documentation/i })).toHaveAttribute(
      'href',
      DOCS_BASE_URL,
    );
  });
});
