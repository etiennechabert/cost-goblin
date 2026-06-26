import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

const AWS_CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';

const DEFAULT_HINT = 'A browser window will open. Refresh this page after logging in.';

export function SsoLoginButton({ profile, hint = DEFAULT_HINT }: Readonly<{ profile: string; hint?: string }>) {
  const api = useCostApi();
  const [cliMissing, setCliMissing] = useState(false);

  if (cliMissing) {
    return (
      <div className="mt-2 text-xs text-text-secondary">
        <span>AWS CLI is not installed. </span>
        <a href={AWS_CLI_INSTALL_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
          Install the AWS CLI
        </a>
        <span> and restart CostGoblin.</span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <button
        type="button"
        onClick={() => {
          api.ssoLogin(profile).catch((err: unknown) => {
            if (err instanceof Error && err.message.includes('AWS_CLI_NOT_FOUND')) {
              setCliMissing(true);
            }
          });
        }}
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
      >
        Open SSO Login
      </button>
      <span className="text-xs text-text-secondary">{hint}</span>
    </div>
  );
}
