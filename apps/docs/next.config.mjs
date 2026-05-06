import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  basePath: "/docs",
  output: "export",
  images: { unoptimized: true },
};

export default withMDX(config);
