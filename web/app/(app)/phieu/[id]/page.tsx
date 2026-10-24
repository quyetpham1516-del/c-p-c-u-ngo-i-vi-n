'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../../src/screens/TransferPrint').then((m) => m.TransferPrint), { ssr: false });
