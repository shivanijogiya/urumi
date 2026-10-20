import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes, Providers, makeQueryClient } from '../src/App.js';

/** Renders the whole app at `path` with a fresh query cache. Network comes from stubApi(). */
export function renderApp(path: string) {
  const user = userEvent.setup();
  const client = makeQueryClient();
  const view = render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </Providers>,
  );
  return { user, client, ...view };
}
