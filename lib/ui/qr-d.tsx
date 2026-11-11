"use client";
import { useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { QRCodeSVG, QRCodeCanvas } from "qrcode.react";
import { getStoreTableQrLinks, type TableQrLink } from "../data";
import { Button } from "./common";
import { printGroups, tableQrUrl } from "./store-d-helpers";
export function QrCardD({
  link,
  storeName,
  download = false,
}: {
  link: TableQrLink;
  storeName: string;
  download?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const url = tableQrUrl(link.url, process.env.NEXT_PUBLIC_SITE_URL);
  return (
    <article className="card d-qr">
      <h2>{storeName}</h2>
      <h3>{link.label} 桌</h3>
      <p>扫码点餐</p>
      <QRCodeSVG
        value={url}
        level="M"
        marginSize={4}
        size={256}
        title={`${link.label} 桌二维码`}
      />
      {download && (
        <>
          <div className="d-download-canvas">
            <QRCodeCanvas
              ref={canvas}
              value={url}
              level="M"
              marginSize={4}
              size={1024}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              if (!canvas.current) return;
              const a = document.createElement("a");
              a.download = `${link.label}-桌-二维码.png`;
              a.href = canvas.current.toDataURL("image/png");
              a.click();
            }}
          >
            下载
          </Button>
        </>
      )}
    </article>
  );
}
export function QrPrintD({
  links,
  storeName,
}: {
  links: TableQrLink[];
  storeName: string;
}) {
  return createPortal(
    <div className="d-print">
      {printGroups(links).map((group, i) => (
        <section
          key={i}
          className={`d-print-sheet${group.breakAfter ? " d-page-break" : ""}`}
        >
          {group.cards.map((link) => (
            <QrCardD key={link.table_id} link={link} storeName={storeName} />
          ))}
        </section>
      ))}
    </div>,
    document.body,
  );
}

export function TableDownloadD({
  id,
  onError,
}: {
  id: string;
  onError: (e: unknown) => void;
}) {
  const [link, setLink] = useState<TableQrLink>();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);
  return (
    <>
      <Button
        variant="secondary"
        busy={busy}
        onClick={() => {
          setBusy(true);
          void getStoreTableQrLinks([id])
            .then(([next]) => {
              flushSync(() => setLink(next));
              if (!ref.current) throw new Error("二维码生成失败");
              const a = document.createElement("a");
              a.download = `${next.label}-桌-二维码.png`;
              a.href = ref.current.toDataURL("image/png");
              a.click();
            })
            .catch(onError)
            .finally(() => setBusy(false));
        }}
      >
        下载
      </Button>
      {link && (
        <div className="d-download-canvas">
          <QRCodeCanvas
            ref={ref}
            value={tableQrUrl(link.url, process.env.NEXT_PUBLIC_SITE_URL)}
            level="M"
            marginSize={4}
            size={1024}
          />
        </div>
      )}
    </>
  );
}
