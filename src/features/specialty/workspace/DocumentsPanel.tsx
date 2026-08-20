'use client';

/**
 * The Documents tab.
 *
 * A document workspace rather than one flat attachment list: the same five shelves an
 * agent looks on — what the customer gave us, what we sent each carrier, what each
 * carrier sent back, underwriting paperwork, and everything else.
 *
 * The grouping is a *reading* of `specialty_documents.category`. No new column, no
 * second storage system, no re-upload: the ten stored categories map onto the five
 * groups in `application.ts`, and a legacy document adopted from the Commercial Board
 * still points at its original bucket and is signed from there.
 */

import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import { deleteDocument, getDocumentUrl, uploadDocument } from '../api';
import {
  DOCUMENT_GROUP_ORDER,
  documentGroup,
  documentGroupLabel,
  type DocumentGroupKey,
} from '../application';
import {
  DOCUMENT_CATEGORIES,
  documentCategoryLabel,
  formatFileSize,
  formatRelative,
} from '../status';
import type { DocumentCategory, OpportunityDetail, SpecialtyDocument } from '../types';
import { Badge, Field, SectionCard, type Runner } from './shared';

export default function DocumentsPanel({
  detail,
  profileId,
  run,
  busy,
  setError,
}: {
  detail: OpportunityDetail;
  /** Whose account this is, for the one action the server scopes to the uploader. */
  profileId: string;
  run: Runner;
  busy: boolean;
  setError: (message: string | null) => void;
}) {
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [carrierMarketId, setCarrierMarketId] = useState('');

  const canEdit = detail.can_edit;

  /**
   * Mirrors the delete policy on `specialty_documents` exactly.
   *
   * The policy admits the uploader or a manager, on a document in the specialty bucket.
   * Offering the button more widely than that would put a Remove control in front of an
   * agent whose click the database is going to refuse — which is the accidental exposure
   * the redesign was told to avoid, and it reads as a bug either way.
   */
  const canRemove = (document: SpecialtyDocument) =>
    canEdit &&
    !document.is_legacy &&
    (document.uploaded_by === profileId || detail.is_manager);

  const grouped = useMemo(() => {
    const map = new Map<DocumentGroupKey, SpecialtyDocument[]>();
    for (const document of detail.documents) {
      const key = documentGroup(document.category);
      const list = map.get(key) ?? [];
      list.push(document);
      map.set(key, list);
    }
    return map;
  }, [detail.documents]);

  const open = useCallback(
    async (document: SpecialtyDocument) => {
      try {
        const url = await getDocumentUrl(document);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That document could not be opened.');
      }
    },
    [setError],
  );

  const carrierName = (id: string | null) =>
    detail.carrier_markets.find((market) => market.id === id)?.carrier_name ?? null;

  return (
    <div className="space-y-5">
      {canEdit ? (
        <SectionCard
          title="Add a document"
          description="Up to 100 MB. The category decides which shelf it lands on; relating it to a carrier also shows it inside that carrier's workstream."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category">
              <select
                className={ui.select}
                value={category}
                onChange={(event) => setCategory(event.target.value as DocumentCategory)}
              >
                {DOCUMENT_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {documentCategoryLabel(option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Related carrier (optional)">
              <select
                className={ui.select}
                value={carrierMarketId}
                onChange={(event) => setCarrierMarketId(event.target.value)}
              >
                <option value="">The quote itself</option>
                {detail.carrier_markets.map((market) => (
                  <option key={market.id} value={market.id}>
                    {market.carrier_name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <label className={`${ui.btnSecondary} cursor-pointer`}>
                <Upload className="h-4 w-4" />
                Choose a file
                <input
                  type="file"
                  className="hidden"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    void run(async () => {
                      await uploadDocument(detail.opportunity.id, file, {
                        category,
                        carrierMarketId: carrierMarketId || null,
                      });
                    }, `${file.name} was uploaded.`);
                  }}
                />
              </label>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {detail.documents.length === 0 ? (
        <p className={ui.empty}>
          No documents yet. Loss runs, declarations, registrations, licences, carrier applications and
          carrier proposals all live here.
        </p>
      ) : (
        DOCUMENT_GROUP_ORDER.map((group) => {
          const documents = grouped.get(group);
          if (!documents || documents.length === 0) return null;
          return (
            <SectionCard
              key={group}
              title={documentGroupLabel(group)}
              actions={<Badge tone="neutral">{documents.length}</Badge>}
            >
              <ul className="space-y-2">
                {documents.map((document) => (
                  <li
                    key={document.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                        <span className="truncate">{document.file_name}</span>
                      </p>
                      <p className="mt-0.5 text-xs font-bold text-slate-400">
                        {[
                          documentCategoryLabel(document.category),
                          carrierName(document.carrier_market_id),
                          formatFileSize(document.file_size),
                          document.uploaded_by_name,
                          formatRelative(document.created_at),
                          document.is_legacy ? 'migrated from the Commercial Board' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={ui.btnSecondary}
                        onClick={() => void open(document)}
                      >
                        <Download className="h-4 w-4" />
                        Open
                      </button>
                      {canRemove(document) ? (
                        <button
                          type="button"
                          className={ui.btnDanger}
                          disabled={busy}
                          aria-label={`Remove ${document.file_name}`}
                          onClick={() =>
                            void run(
                              () => deleteDocument(document),
                              `${document.file_name} was removed.`,
                            )
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          );
        })
      )}
    </div>
  );
}
