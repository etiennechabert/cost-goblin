import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

const AWS_CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';

export function SsoLoginButton({ profile }: Readonly<{ profile: string }>) {
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
    <div className="flex items-center gap-3 mt-2">
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
      <span className="text-xs text-text-secondary">A browser window will open. Refresh this page after logging in.</span>
    </div>
  );
}
