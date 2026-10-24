'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../../../src/screens/Trace').then((m) => m.Trace), { ssr: false });
