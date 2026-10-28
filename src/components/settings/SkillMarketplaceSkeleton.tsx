export function SkillMarketplaceSkeleton({ grouped = true }: { grouped?: boolean }) {
  return <div className="app-skill-market-skeleton" aria-hidden="true">
    {Array.from({ length: grouped ? 2 : 1 }, (_, section) => <section className="app-skill-market-section" key={section}>
      <div className="app-skill-market-skeleton-block app-skill-market-skeleton-heading" />
      <div className="app-skill-market-grid">
        {Array.from({ length: grouped ? 6 : 12 }, (_, index) => <div className="app-skill-market-card" key={index}>
          <div className="app-skill-market-skeleton-block app-skill-market-skeleton-avatar" />
          <div className="app-skill-market-card-main">
            <div className="app-skill-market-skeleton-block app-skill-market-skeleton-title" />
            <div className="app-skill-market-description-placeholder">
              <div className="app-skill-market-skeleton-block app-skill-market-skeleton-line" />
              <div className="app-skill-market-skeleton-block app-skill-market-skeleton-line-short" />
            </div>
            <div className="app-skill-market-skeleton-block app-skill-market-skeleton-meta" />
          </div>
          <div className="app-skill-market-skeleton-block app-skill-market-skeleton-action" />
        </div>)}
      </div>
    </section>)}
  </div>;
}
