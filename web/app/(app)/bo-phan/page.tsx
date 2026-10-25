'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/OrgReports').then((m) => m.OrgReports), { ssr: false });
