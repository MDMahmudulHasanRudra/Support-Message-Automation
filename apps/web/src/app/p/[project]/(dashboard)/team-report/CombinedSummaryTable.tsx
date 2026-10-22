import { ADDITIVITY_LABELS, type CombinedLine } from "@support-automation/shared";
import { SectionHeader, Table, Td, Th } from "@/components/ui";

const cell = (value: number | string | null) => (value === null ? "—" : typeof value === "number" ? value.toLocaleString("en-US") : value);

/**
 * Groups and personal chats side by side (`scope=combined`). Each combined cell says HOW it was
 * combined — added, recalculated over both lists of waits, or not offered at all — so a reader never
 * mistakes a sum of two different units, or an average of two medians, for a measurement.
 */
export function CombinedSummaryTable({ lines }: { lines: CombinedLine[] }) {
  return (
    <div className="mb-5">
      <SectionHeader
        title="Groups and personal chats"
        description="Shown side by side. Combined figures add only what can be added; a customer who wrote in a group and in a personal chat is counted in both."
      />
      <Table>
        <thead>
          <tr>
            <Th>Figure</Th>
            <Th>Groups</Th>
            <Th>Personal</Th>
            <Th>Combined</Th>
            <Th>How combined</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.label}>
              <Td>
                <span className="font-medium">{line.label}</span>
                {line.note ? <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">{line.note}</span> : null}
              </Td>
              <Td className="tabular">{cell(line.group)}</Td>
              <Td className="tabular">{cell(line.personal)}</Td>
              <Td className="tabular font-medium">{cell(line.combined)}</Td>
              <Td className="text-[12px] text-[color:var(--color-muted-foreground)]">{ADDITIVITY_LABELS[line.additivity]}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
