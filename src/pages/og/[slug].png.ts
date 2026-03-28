import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

// Font loading (cached at module level)
const fontRegular = fetch(
  'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf'
).then((r) => r.arrayBuffer());

const fontBold = fetch(
  'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf'
).then((r) => r.arrayBuffer());

const fontExtraBold = fetch(
  'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuDyYMZg.ttf'
).then((r) => r.arrayBuffer());

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection('blog');
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const post = (props as any).post;
  const { title, date, tags } = post.data;

  const formattedDate = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Logo SVG as a data URI for the watermark
  const logoSvg = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="6" r="3" fill="rgba(59,130,246,0.25)"/>
    <circle cx="8" cy="18" r="2.5" fill="rgba(6,182,212,0.2)"/>
    <circle cx="32" cy="18" r="2.5" fill="rgba(6,182,212,0.2)"/>
    <circle cx="12" cy="32" r="2" fill="rgba(139,92,246,0.2)"/>
    <circle cx="28" cy="32" r="2" fill="rgba(139,92,246,0.2)"/>
    <circle cx="20" cy="20" r="3" fill="rgba(59,130,246,0.25)"/>
    <line x1="20" y1="9" x2="20" y2="17" stroke="rgba(59,130,246,0.15)" stroke-width="1.5"/>
    <line x1="10" y1="18" x2="17" y2="20" stroke="rgba(6,182,212,0.12)" stroke-width="1.5"/>
    <line x1="30" y1="18" x2="23" y2="20" stroke="rgba(6,182,212,0.12)" stroke-width="1.5"/>
    <line x1="13" y1="31" x2="18" y2="22" stroke="rgba(139,92,246,0.12)" stroke-width="1.5"/>
    <line x1="27" y1="31" x2="22" y2="22" stroke="rgba(139,92,246,0.12)" stroke-width="1.5"/>
  </svg>`;
  const logoDataUri = `data:image/svg+xml,${encodeURIComponent(logoSvg)}`;

  const tagElements = (tags ?? []).slice(0, 5).map((tag: string) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        backgroundColor: '#3B82F6',
        color: '#FFFFFF',
        fontSize: '14px',
        fontWeight: 600,
        padding: '4px 14px',
        borderRadius: '9999px',
      },
      children: tag,
    },
  }));

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          background: 'linear-gradient(180deg, #0F172A 0%, #1E293B 100%)',
        },
        children: {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              padding: '60px',
              position: 'relative',
            },
            children: [
              // Watermark logo
              {
                type: 'img',
                props: {
                  src: logoDataUri,
                  width: 400,
                  height: 400,
                  style: {
                    position: 'absolute',
                    bottom: '-40px',
                    right: '-20px',
                    opacity: 0.6,
                  },
                },
              },
              // Logo
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'row',
                    marginBottom: '40px',
                  },
                  children: [
                    {
                      type: 'span',
                      props: {
                        style: {
                          fontSize: '20px',
                          fontWeight: 700,
                          color: '#F8FAFC',
                          letterSpacing: '3px',
                        },
                        children: 'ALTAIRA',
                      },
                    },
                    {
                      type: 'span',
                      props: {
                        style: {
                          fontSize: '20px',
                          fontWeight: 700,
                          color: '#64748B',
                          letterSpacing: '3px',
                        },
                        children: 'LABS',
                      },
                    },
                  ],
                },
              },
              // Title
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flex: 1,
                  },
                  children: {
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        fontSize: title.length > 60 ? '42px' : '52px',
                        fontWeight: 800,
                        color: '#F8FAFC',
                        lineHeight: 1.2,
                      },
                      children: title,
                    },
                  },
                },
              },
              // Date
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    fontSize: '18px',
                    color: '#64748B',
                    marginBottom: '16px',
                  },
                  children: formattedDate,
                },
              },
              // Tags
              ...(tagElements.length > 0
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'row' as const,
                          gap: '8px',
                          marginBottom: '24px',
                        },
                        children: tagElements,
                      },
                    },
                  ]
                : []),
              // Bottom gradient bar
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '100%',
                    height: '4px',
                    background: 'linear-gradient(90deg, #3B82F6 0%, #06B6D4 50%, #8B5CF6 100%)',
                    borderRadius: '2px',
                  },
                  children: '',
                },
              },
            ],
          },
        },
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'Inter',
          data: await fontRegular,
          weight: 400,
          style: 'normal' as const,
        },
        {
          name: 'Inter',
          data: await fontBold,
          weight: 700,
          style: 'normal' as const,
        },
        {
          name: 'Inter',
          data: await fontExtraBold,
          weight: 800,
          style: 'normal' as const,
        },
      ],
    }
  );

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1200,
    },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
