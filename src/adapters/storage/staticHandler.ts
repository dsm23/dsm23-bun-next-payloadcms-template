import path from "node:path";
import type { Readable } from "node:stream";
import type { CollectionConfig } from "payload";
import { getFilePrefix } from "@payloadcms/plugin-cloud-storage/utilities";
import type { StaticHandler } from "@payloadcms/plugin-cloud-storage/types";
import type { Client } from "minio";

interface Args {
  bucket: string;
  collection: CollectionConfig;
  getStorageClient: () => Client;
}

// Type guard for NodeJS.Readable streams
const isNodeReadableStream = (body: unknown): body is Readable => {
  return (
    typeof body === "object" &&
    body !== null &&
    "pipe" in body &&
    typeof (body as Readable).pipe === "function" &&
    "destroy" in body &&
    typeof (body as Readable).destroy === "function"
  );
};

// Convert a stream into a promise that resolves with a Buffer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const streamToBuffer = async (readableStream: any) => {
  const chunks = [];
  for await (const chunk of readableStream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

export const getHandler = ({
  bucket,
  collection,
  getStorageClient,
}: Args): StaticHandler => {
  return async (req, { params: { filename } }) => {
    try {
      const prefix = await getFilePrefix({ collection, filename, req });

      const key = path.posix.join(prefix, filename);

      const stat = await getStorageClient().statObject(bucket, key);

      if (!stat) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }

      const etagFromHeaders =
        req.headers.get("etag") || req.headers.get("if-none-match");
      const objectEtag = `"${stat.etag}"`; // Minio etags are quoted

      if (etagFromHeaders && etagFromHeaders === objectEtag) {
        const response = new Response(null, {
          headers: new Headers({
            "Accept-Ranges": "bytes", // Minio always supports byte-serving
            "Content-Length": String(stat.size),
            "Content-Type": String(stat.metaData["content-type"]), // Access content-type from metadata
            ETag: objectEtag,
          }),
          status: 304,
        });

        return response;
      }

      const objectStream = await getStorageClient().getObject(bucket, key);

      // On error, manually destroy stream to close socket
      if (objectStream && isNodeReadableStream(objectStream)) {
        const stream = objectStream;
        stream.on("error", (err) => {
          req.payload.logger.error({
            err,
            key,
            msg: "Error streaming Minio object, destroying stream",
          });
          stream.destroy();
        });
      }

      const bodyBuffer = await streamToBuffer(objectStream);

      return new Response(bodyBuffer, {
        headers: new Headers({
          "Accept-Ranges": "bytes", // Minio always supports byte-serving
          "Content-Length": String(stat.size),
          "Content-Type": String(stat.metaData["content-type"]), // Access content-type from metadata
          ETag: objectEtag,
        }),
        status: 200,
      });
    } catch (err) {
      req.payload.logger.error(err);
      return new Response("Internal Server Error", { status: 500 });
    }
  };
};
