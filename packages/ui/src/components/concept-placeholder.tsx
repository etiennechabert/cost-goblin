interface ConceptPlaceholderProps {
  concept: 'owner' | 'product' | 'environment';
}

const CONCEPTS = {
  owner: {
    icon: '[team]',
    label: 'Ownership',
    description:
      'Configure an ownership dimension to see cost by team. Add `concept: owner` to a tag dimension in `dimensions.yaml`.',
  },
  product: {
    icon: '[pkg]',
    label: 'Product',
    description:
      'Configure a product dimension to see cost by application. Add `concept: product` to a tag dimension in `dimensions.yaml`.',
  },
  environment: {
    icon: '[layers]',
    label: 'Environment',
    description:
      'Configure an environment dimension to filter by prod/staging/dev. Add `concept: environment` to a tag dimension in `dimensions.yaml`.',
  },
} as const;

export function ConceptPlaceholder({ concept }: Readonly<ConceptPlaceholderProps>) {
  const { icon, label, description } = CONCEPTS[concept];

  return (
    <div className="rounded-xl border border-dashed border-border bg-bg-secondary/20 p-6 text-center">
      <div className="text-2xl text-text-muted mb-3">{icon}</div>
      <p className="text-sm font-medium text-text-muted mb-1">{label} not configured</p>
      <p className="text-xs text-text-muted max-w-sm mx-auto">{description}</p>
    </div>
  );
}
